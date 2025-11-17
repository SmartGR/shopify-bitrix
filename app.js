// src/app.js

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// CONFIG BITRIX
// -----------------------------------------------------------------------------

// BITRIX_WEBHOOK_BASE vem das variáveis de ambiente do Render.
// Exemplo de valor: https://smartgr.bitrix24.com.br/rest/12/h0ah2vd1xnc0nncv/
const rawBase =
  process.env.BITRIX_WEBHOOK_BASE ||
  "https://smartgr.bitrix24.com.br/rest/12/h0ah2vd1xnc0nncv/";

// garante 1 barra só no final
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
// CONFIG DO FUNIL (Varejo)
// -----------------------------------------------------------------------------

// Funil VAREJO (CATEGORY_ID = 1)
const CATEGORY_ID = 1;

// IDs das fases (confere no Bitrix se estiver diferente)
const STAGE_NEW = "C1:NEW";   // 1. Abordagem e envio de material
const STAGE_WON = "C1:WON";   // 6. Fechados
const STAGE_LOST = "C1:LOSE"; // 7. Perdido

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

// Define a fase do funil com base no status financeiro + tópico do webhook
function mapStage(order, topicRaw) {
  const topic = (topicRaw || "").toLowerCase();
  const fs = (order.financial_status || "").toLowerCase();

  const isCancelled =
    !!order.cancelled_at || topic.includes("cancelled");
  const isPaid =
    topic.includes("paid") ||
    fs === "paid" ||
    fs === "partially_paid";

  if (isCancelled) {
    return STAGE_LOST;
  }

  if (isPaid) {
    return STAGE_WON;
  }

  // pending, authorized, etc.
  return STAGE_NEW;
}

// Busca negócio no Bitrix pelo ID do pedido da Shopify
async function findDealByShopifyId(orderId) {
  const resp = await axios.post(bitrixUrl("crm.deal.list"), {
    filter: {
      ORIGINATOR_ID: "SHOPIFY",
      ORIGIN_ID: String(orderId),
    },
    select: ["ID"],
  });

  const result = resp.data.result || [];
  if (result.length > 0) {
    return result[0].ID; // ID do negócio
  }
  return null;
}

// Monta os campos do negócio a partir do pedido
function buildDealFields(order, topic) {
  const customer = order.customer || {};
  const address =
    order.shipping_address || order.billing_address || {};

  const phone =
    customer.phone ||
    address.phone ||
    order.phone ||
    "";

  const email = customer.email || order.email || "";

  const productsString = (order.line_items || [])
    .map((item) => `${item.quantity}x ${item.title}`)
    .join(", ");

  const stageToUse = mapStage(order, topic);

  const fullName =
    `${customer.first_name || ""} ${customer.last_name || ""}`.trim();

  // Endereço em linha única
  const addressLine = `${address.address1 || ""} ${
    address.address2 || ""
  }`.trim();

  const commentsText = `
Status financeiro: ${order.financial_status || "N/A"}
Status de envio: ${order.fulfillment_status || "N/A"}
Status Shopify: ${order.cancelled_at ? "Cancelado" : "Ativo"}

Cliente: ${fullName || "N/A"}
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

  const fields = {
    TITLE: `Pedido Shopify ${order.name || order.id}`,
    CATEGORY_ID,
    STAGE_ID: stageToUse,
    OPPORTUNITY: order.total_price ? Number(order.total_price) : 0,
    CURRENCY_ID: order.currency || "BRL",

    // ligação com a Shopify
    ORIGINATOR_ID: "SHOPIFY",
    ORIGIN_ID: String(order.id),

    // endereço (campos padrão do negócio no Bitrix)
    ADDRESS: addressLine,
    ADDRESS_CITY: address.city || "",
    ADDRESS_REGION: address.province || "",
    ADDRESS_PROVINCE: address.province || "",
    ADDRESS_POSTAL_CODE: address.zip || "",
    ADDRESS_COUNTRY: address.country || "",

    COMMENTS: commentsText,
  };

  return fields;
}

// -----------------------------------------------------------------------------
// HANDLER ÚNICO PARA TODOS OS WEBHOOKS DA SHOPIFY
// -----------------------------------------------------------------------------

async function shopifyWebhookHandler(req, res) {
  try {
    const order = req.body || {};
    const topic = req.headers["x-shopify-topic"] || "";

    console.log(
      "Webhook Shopify recebido:",
      topic,
      order.id,
      order.name,
      order.financial_status
    );

    // Se por algum motivo vier vazio, loga o body bruto pra debug
    if (!order.id) {
      console.log(
        "Body bruto (sem order.id):",
        JSON.stringify(req.body).slice(0, 500)
      );
    }

    const fields = buildDealFields(order, topic);

    // -------------------------------------------------------------------------
    // CRIA OU ATUALIZA NEGÓCIO
    // -------------------------------------------------------------------------

    const existingDealId = await findDealByShopifyId(order.id);
    let bitrixResponse;

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
    }

    console.log("Resposta Bitrix:", bitrixResponse.data);

    if (bitrixResponse.data.error) {
      console.error("Erro Bitrix:", bitrixResponse.data);
      return res
        .status(500)
        .send("Erro Bitrix: " + bitrixResponse.data.error_description);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Erro integração Shopify → Bitrix:");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error(err.message);
    }
    res.status(500).send("Erro ao integrar");
  }
}

// -----------------------------------------------------------------------------
// ROTAS QUE A SHOPIFY CHAMA
// -----------------------------------------------------------------------------
//
// Você configurou na Shopify a URL:
//   https://shopify-bitrix.onrender.com/webhook
//
// Mas como em algum momento já usamos /shopify-order,
// deixei as duas rotas apontando para o mesmo handler. ;)
// -----------------------------------------------------------------------------

app.post("/webhook", shopifyWebhookHandler);
app.post("/shopify-order", shopifyWebhookHandler);

// -----------------------------------------------------------------------------
// SERVIDOR (Render exige que a app fique ouvindo numa porta)
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor ouvindo na porta", PORT);
});
