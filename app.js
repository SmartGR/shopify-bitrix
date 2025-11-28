// src/app.js

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// CONFIG BITRIX
// -----------------------------------------------------------------------------

const rawBase =
  process.env.BITRIX_WEBHOOK_BASE ||
  "https://smartgr.bitrix24.com.br/rest/12/h0ah2vd1xnc0nncv/";

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

// Cidade (CORRIGIDO: O final era BDC no seu código, mas no JSON é 8DC)
const FIELD_CITY = "UF_CRM_68F66E44278DC";

// Estado (campo personalizado no negócio - tipo LISTA)
const FIELD_STATE = "UF_CRM_68F66E4434B01";

// -----------------------------------------------------------------------------
// FUNIL / ESTÁGIOS (VAREJO = CATEGORY_ID 7)
// -----------------------------------------------------------------------------

const CATEGORY_ID = 7;
const STAGE_NEW = "C7:NEW";
const STAGE_WON = "C7:WON";
const STAGE_LOST = "C7:LOSE";

// -----------------------------------------------------------------------------
// MAPA DE ESTADOS (FIXO PARA EVITAR ERRO DE API)
// -----------------------------------------------------------------------------
const STATE_MAP = {
  AC: "423",
  AL: "425",
  AP: "427",
  AM: "429",
  BA: "431",
  CE: "433",
  DF: "435",
  ES: "437",
  GO: "439",
  MA: "441",
  MT: "443",
  MS: "445",
  MG: "447",
  PA: "449",
  PB: "451",
  PR: "453",
  PE: "455",
  PI: "457",
  RJ: "459",
  RN: "461",
  RS: "463",
  RO: "465",
  RR: "467",
  SC: "469",
  SP: "471",
  SE: "473",
  TO: "475",
};

// -----------------------------------------------------------------------------
// HELPERS - ESTÁGIO
// -----------------------------------------------------------------------------

function mapStage(order) {
  const fs = (order.financial_status || "").toLowerCase();

  if (fs === "paid" || fs === "partially_paid") {
    return STAGE_WON;
  }
  if (fs === "refunded" || fs === "voided") {
    return STAGE_LOST;
  }

  return STAGE_NEW;
}

// -----------------------------------------------------------------------------
// HELPERS - ESTADO
// -----------------------------------------------------------------------------

// Mantivemos a função async para não quebrar seu código principal,
// mas agora ela usa o mapa fixo.
async function mapStateToBitrixValue(address) {
  // A Shopify manda province_code (ex: SP, RJ). Se não tiver, tentamos province.
  const uf = (address.province_code || address.province || "")
    .toUpperCase()
    .trim();

  if (!uf) return null;

  // Busca direto no mapa
  const optionId = STATE_MAP[uf];

  if (!optionId) {
    console.warn("UF sem opção correspondente no campo Estado:", uf);
    return null;
  }

  return optionId;
}

// -----------------------------------------------------------------------------
// HELPERS - NEGÓCIO / CONTATO / PRODUTOS
// -----------------------------------------------------------------------------

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
      return result[0].ID;
    }
    return null;
  } catch (e) {
    console.error("Erro ao buscar negócio por ID Shopify:", e.message);
    return null;
  }
}

async function findOrCreateContact({
  firstName,
  lastName,
  email,
  phone,
  address,
}) {
  try {
    let contact = null;

    // 1) tenta achar por e-mail
    if (email) {
      const respByEmail = await axios.post(bitrixUrl("crm.contact.list"), {
        filter: { EMAIL: email },
        select: ["ID", "PHONE", "EMAIL"],
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
        select: ["ID", "PHONE", "EMAIL"],
      });
      const list = respByPhone.data.result || [];
      if (list.length > 0) {
        contact = list[0];
      }
    }

    // Atualiza contato existente com telefone/email do pedido
    if (contact) {
      const updateFields = {};

      if (email) {
        updateFields.EMAIL = [
          {
            VALUE: email,
            VALUE_TYPE: "WORK",
          },
        ];
      }

      if (phone) {
        updateFields.PHONE = [
          {
            VALUE: phone,
            VALUE_TYPE: "MOBILE",
          },
        ];
      }

      if (Object.keys(updateFields).length > 0) {
        try {
          await axios.post(bitrixUrl("crm.contact.update"), {
            id: contact.ID,
            fields: updateFields,
          });
          console.log("Contato atualizado com dados da Shopify:", contact.ID);
        } catch (e) {
          console.error(
            "Erro ao atualizar contato:",
            e.response?.data || e.message
          );
        }
      }

      return contact.ID;
    }

    // 3) cria contato novo
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
      const addrLine = `${address.address1 || ""} ${
        address.address2 || ""
      }`.trim();
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
      return createResp.data.result;
    }

    console.error("Erro ao criar contato no Bitrix:", createResp.data);
    return null;
  } catch (e) {
    console.error("Erro em findOrCreateContact:", e.message);
    return null;
  }
}

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
    console.error(
      "Erro ao definir produtos no negócio:",
      e.response?.data || e.message
    );
  }
}

// -----------------------------------------------------------------------------
// ROTA QUE A SHOPIFY CHAMA (WEBHOOKS)
// -----------------------------------------------------------------------------

app.post("/webhook", async (req, res) => {
  // responde rápido para a Shopify
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
    const address = order.shipping_address || order.billing_address || {};

    const phone = customer.phone || address.phone || order.phone || "";

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

    // MANTIDO EXATAMENTE COMO VOCÊ QUERIA
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

    const contactId = await findOrCreateContact({
      firstName,
      lastName,
      email,
      phone,
      address,
    });

    // Estado: AGORA USA O MAPA CORRIGIDO
    const stateEnumId = await mapStateToBitrixValue(address);

    const fields = {
      TITLE: `Pedido Shopify ${order.name || order.id}`,
      CATEGORY_ID,
      STAGE_ID: stageToUse,
      OPPORTUNITY: order.total_price ? Number(order.total_price) : 0,
      CURRENCY_ID: order.currency || "BRL",

      ORIGINATOR_ID: "SHOPIFY",
      ORIGIN_ID: String(order.id),

      [FIELD_SHOPIFY_ID]: String(order.id),

      ...(contactId ? { CONTACT_ID: contactId } : {}),

      ADDRESS: addressLine,
      ADDRESS_CITY: address.city || "",
      ADDRESS_REGION: address.province || "",
      ADDRESS_PROVINCE: address.province || "",
      ADDRESS_POSTAL_CODE: address.zip || "",
      ADDRESS_COUNTRY: address.country || "",

      // CIDADE COM O ID CORRIGIDO
      [FIELD_CITY]: address.city || "",

      // ESTADO COM O ID DA LISTA
      ...(stateEnumId ? { [FIELD_STATE]: stateEnumId } : {}),

      COMMENTS: commentsText,
    };

    // MANTIDO SEU LOG
    console.log("algo", fields);

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
// SERVIDOR
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor ouvindo na porta", PORT);
});
