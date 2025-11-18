// src/app.js

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// CONFIG BITRIX
// -----------------------------------------------------------------------------

// No Render você tem a variável BITRIX_WEBHOOK_BASE.
// Exemplo: https://smartgr.bitrix24.com.br/rest/12/h0ah2vd1xnc0nncv/
const rawBase =
  process.env.BITRIX_WEBHOOK_BASE ||
  "https://smartgr.bitrix24.com.br/rest/12/h0ah2vd1xnc0nncv/";

// garante só 1 barra no final
const BITRIX_WEBHOOK_BASE = rawBase.replace(/\/+$/, "") + "/";

if (!rawBase) {
  console.error(
    "ERRO: BITRIX_WEBHOOK_BASE não definido nas variáveis de ambiente"
  );
}

function bitrixUrl(method) {
  const url = `${BITRIX_WEBHOOK_BASE}${method}.json`;
  console.log("URL Bitrix usada:", url);
  return url;
}

// -----------------------------------------------------------------------------
// CAMPOS PERSONALIZADOS (NEGÓCIO)
// -----------------------------------------------------------------------------

// ID do Pedido Shopify
const FIELD_SHOPIFY_ID = "UF_CRM_1763463761";

// Cidade (campo personalizado no negócio)
const FIELD_CITY = "UF_CRM_68F66E4427BDC";

// Estado (campo personalizado no negócio)
const FIELD_STATE = "UF_CRM_68F66E4434B01";

// -----------------------------------------------------------------------------
// FUNIL / ESTÁGIOS (VAREJO = CATEGORY_ID 7)
// -----------------------------------------------------------------------------

const CATEGORY_ID = 7;
const STAGE_NEW = "C7:NEW";   // Apresentação inicial / início
const STAGE_WON = "C7:WON";   // Fechados (sucesso)
const STAGE_LOST = "C7:LOSE"; // Perdido

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

// Define a fase do funil com base no status financeiro da Shopify
function mapStage(order) {
  const fs = (order.financial_status || "").toLowerCase();

  if (fs === "paid" || fs === "partially_paid") {
    return STAGE_WON;
  }
  if (fs === "refunded" || fs === "voided") {
    return STAGE_LOST;
  }

  // pending, authorized, etc…
  return STAGE_NEW;
}

// Busca negócio no Bitrix pelo ID do pedido da Shopify (campo personalizado)
async function findDealByShopifyId(orderId) {
  try {
    const resp = await axios.post(bitrixUrl("crm.deal.list"), {
      filter: {
        [FIELD_SHOPIFY_ID]: String(orderId),
      },
      select: ["ID"],
    });

    const result = resp.data.result || [];
    if (result.length > 0) {
      console.log(
        "Negócio encontrado pelo ID Shopify:",
        orderId,
        "→ Deal ID",
        result[0].ID
      );
      return result[0].ID; // ID do negócio
    }
    return null;
  } catch (e) {
    console.error("Erro ao buscar negócio por ID Shopify:", e.message);
    return null;
  }
}

// Cria ou reaproveita um Contato no Bitrix com base em e-mail/telefone
async function findOrCreateContact({ firstName, lastName, email, phone, address }) {
  try {
    let contact = null;

    // 1) tenta achar por e-mail
    if (email) {
      const respByEmail = await axios.post(bitrixUrl("crm.contact.list"), {
        filter: { EMAIL: email },
        select: ["ID"],
      });
      const list = respByEmail.data.result || [];
      if (list.length > 0) {
        contact = list[0];
      }
    }

    // 2) se não achou por e-mail, tenta por telefone
    if (!contact && phone) {
      const respByPhone = await axios.post(bitrixUrl("crm.contact.list"), {
        filter: { PHONE: phone },
        select: ["ID"],
      });
      const list = respByPhone.data.result || [];
      if (list.length > 0) {
        contact = list[0];
      }
    }

    if (contact) {
      return contact.ID;
    }

    // 3) se não encontrou, cria um contato novo
    const fields = {
      NAME: firstName || email || phone || "Cliente Shopify",
      LAST_NAME: lastName || "",
      OPENED: "Y",
      TYPE_ID: "CLIENT",
    };

    if (email) {
      fields.EMAIL = [
        {
          VALUE: email,
          VALUE_TYPE: "WORK",
        },
      ];
    }

    if (phone) {
      fields.PHONE = [
        {
          VALUE: phone,
          VALUE_TYPE: "MOBILE",
        },
      ];
    }

    if (address) {
      const addrLine = `${address.address1 || ""} ${address.address2 || ""}`.trim();
      fields.ADDRESS = addrLine;
      fields.ADDRESS_CITY = address.city || "";
      fields.ADDRESS_REGION = address.province || "";
      fields.ADDRESS_PROVINCE = address.province || "";
      fields.ADDRESS_POSTAL_CODE = address.zip || "";
      fields.ADDRESS_COUNTRY = address.country || "";
    }

    const createResp = await axios.post(bitrixUrl("crm.contact.add"), {
      fields,
    });

    if (createResp.data && createResp.data.result) {
      return createResp.data.result; // ID do contato
    }

    console.error("Erro ao criar contato no Bitrix:", createResp.data);
    return null;
  } catch (e) {
    console.error("Erro em findOrCreateContact:", e.message);
    return null;
  }
}

// Define os produtos do negócio a partir dos line_items da Shopify
async function setDealProducts(dealId, lineItems) {
  try {
    if (!dealId) {
      console.warn("setDealProducts chamado sem dealId");
      return;
    }

    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      console.log("Pedido sem line_items para vincular como produtos.");
      return;
    }

    const rows = lineItems.map((item) => ({
      PRODUCT_NAME: item.title || item.name || "Produto Shopify",
      PRICE: item.price ? Number(item.price) : 0,
      QUANTITY: item.quantity ? Number(item.quantity) : 1,
    }));

    const resp = await axios.post(bitrixUrl("crm.deal.productrows.set"), {
      id: dealId,
      rows,
    });

    console.log("Produtos definidos no negócio:", resp.data);
  } catch (e) {
    console.error("Erro ao definir produtos no negócio:", e.response?.data || e.message);
  }
}

// -----------------------------------------------------------------------------
// ROTA QUE A SHOPIFY CHAMA (WEBHOOKS)
// -----------------------------------------------------------------------------

app.post("/webhook", async (req, res) => {
  // responde rápido para a Shopify e processa em background
  res.status(200).send("OK");

  try {
    const order = req.body;

    const topic = req.headers["x-shopify-topic"] || "";
    console.log(
      "Webhook Shopify recebido:",
      topic,
      order.id,
      order.name,
      order.financial_status
    );

    const customer = order.customer || {};
    const address =
      order.shipping_address || order.billing_address || {};

    const phone =
      customer.phone ||
      address.phone ||
      order.phone ||
      "";

    const email = customer.email || order.email || "";

    const firstName = customer.first_name || address.first_name || "";
    const lastName = customer.last_name || address.last_name || "";

    const productsString = (order.line_items || [])
      .map((item) => `${item.quantity}x ${item.title}`)
      .join(", ");

    const stageToUse = mapStage(order);

    const addressLine = `${address.address1 || ""} ${
      address.address2 || ""
    }`.trim();

    const commentsText = `
Status financeiro: ${order.financial_status || "N/A"}
Status de envio: ${order.fulfillment_status || "N/A"}

Cliente: ${(firstName || "") + " " + (lastName || "")}
Email: ${email || "não informado"}
Telefone: ${phone || "não informado"}

Endereço:
${address.address1 || ""} ${address.address2 || ""}
${address.city || ""} - ${address.province || ""}
${address.zip || ""} - ${address.country || ""}

Produtos:
${productsString || "sem itens"}

(Atualizado automaticamente pela Shopify)
`.trim();

    // -------------------------------------------------------------------------
    // CONTATO (para preencher o campo "Cliente" do negócio)
    // -------------------------------------------------------------------------

    const contactId = await findOrCreateContact({
      firstName,
      lastName,
      email,
      phone,
      address,
    });

    // -------------------------------------------------------------------------
    // CAMPOS DO NEGÓCIO
    // -------------------------------------------------------------------------

    const fields = {
      TITLE: `Pedido Shopify ${order.name || order.id}`,
      CATEGORY_ID,
      STAGE_ID: stageToUse,
      OPPORTUNITY: order.total_price ? Number(order.total_price) : 0,
      CURRENCY_ID: order.currency || "BRL",

      // ligação com a Shopify (opcional manter)
      ORIGINATOR_ID: "SHOPIFY",
      ORIGIN_ID: String(order.id),

      // campo personalizado com o ID Shopify (chave de deduplicação)
      [FIELD_SHOPIFY_ID]: String(order.id),

      // contato vinculado
      ...(contactId ? { CONTACT_ID: contactId } : {}),

      // endereço no negócio (campos padrão)
      ADDRESS: addressLine,
      ADDRESS_CITY: address.city || "",
      ADDRESS_REGION: address.province || "",
      ADDRESS_PROVINCE: address.province || "",
      ADDRESS_POSTAL_CODE: address.zip || "",
      ADDRESS_COUNTRY: address.country || "",

      // campos personalizados de Cidade / Estado
      [FIELD_CITY]: address.city || "",
      [FIELD_STATE]: address.province_code || address.province || "",

      COMMENTS: commentsText,
    };

    // -------------------------------------------------------------------------
    // CRIA OU ATUALIZA NEGÓCIO
    // -------------------------------------------------------------------------

    const existingDealId = await findDealByShopifyId(order.id);
    let bitrixResponse;
    let dealId = existingDealId || null;

    if (existingDealId) {
      console.log("Atualizando negócio existente no Bitrix:", existingDealId);
      bitrixResponse = await axios.post(bitrixUrl("crm.deal.update"), {
        id: existingDealId,
        fields,
      });
    } else {
      console.log("Criando novo negócio no Bitrix...");
      bitrixResponse = await axios.post(bitrixUrl("crm.deal.add"), {
        fields,
      });

      if (bitrixResponse.data && bitrixResponse.data.result) {
        dealId = bitrixResponse.data.result;
        console.log("Negócio criado no Bitrix com ID:", dealId);
      }
    }

    if (!dealId && bitrixResponse?.data?.result) {
      dealId = bitrixResponse.data.result;
    }

    if (bitrixResponse.data?.error) {
      console.error("Erro Bitrix:", bitrixResponse.data);
      return;
    }

    // -------------------------------------------------------------------------
    // PRODUTOS DO NEGÓCIO
    // -------------------------------------------------------------------------
    await setDealProducts(dealId, order.line_items || []);
  } catch (err) {
    console.error("Erro integração Shopify → Bitrix:");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error(err.message);
    }
  }
});

// -----------------------------------------------------------------------------
// SERVIDOR (Render exige que a app fique ouvindo numa porta)
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor ouvindo na porta", PORT);
});
