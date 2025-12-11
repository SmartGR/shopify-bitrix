import express from "express";
import axios from "axios";
import dotenv from "dotenv";

import {
  mapStage,
  getBitrixStateId,
  getShopifyMetafields,
  findOrCreateContact,
  updateBitrixCashback,
  setDealProducts,
  findDealByShopifyId,
  findContactByEmail,
  bitrixUrl,
  getBitrixUserIdByName,
  getEduvemDataFromProduct,
  getShopifyOrder,
  enrollStudent,
  enrollStudentInTeam,
  getBonifiqCustomerData,
} from "./functions.js";

import {
  BITRIX_WEBHOOK_BASE,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_DOMAIN,
  CATEGORY_ID,
  FIELD_SHOPIFY_ID,
  FIELD_CITY,
  FIELD_STATE,
  FIELD_SELLER,
  FIELD_INTEREST_PAID,
  FIELD_COD_RASTREIO,
} from "./constants.js";

dotenv.config();

const app = express();
app.use(express.json());

const orderQueues = new Map();

if (!process.env.SHOPIFY_ACCESS_TOKEN)
  console.warn(
    "ALERTA: SHOPIFY_ACCESS_TOKEN não definido. Juros não serão processados."
  );

async function processOrderWebhook(order) {
  try {
    console.log(`[PROCESSANDO] Pedido: ${order.name} (${order.id})`);

    const apiOrder = await getShopifyOrder(order.id);
    const orderData = apiOrder || order;

    const customer = order.customer || {};
    const address = order.shipping_address || order.billing_address || {};
    const email = customer.email || order.email || "";
    const phone = address.phone || customer.phone || order.phone || "";
    const firstName = address.first_name || customer.first_name || "";
    const lastName = address.last_name || customer.last_name || "";

    let codRastreio = orderData.note ?? "";

    const noteAttributes = orderData.note_attributes || [];
    const affiliateObj = noteAttributes.find(
      (attr) => attr.name === "Affiliate"
    );
    const vendedorValue = affiliateObj ? affiliateObj.value : "";

    let assignedById = null;
    if (vendedorValue) {
      assignedById = await getBitrixUserIdByName(vendedorValue);
    }

    const { interest, paidAmount } = await getShopifyMetafields(order.id);

    const productsString = (order.line_items || [])
      .map((i) => `${i.quantity}x ${i.title}`)
      .join(", ");

    const commentsText = `
Status: ${order.financial_status} / ${order.fulfillment_status}
Vendedor: ${vendedorValue}
Juros (Pagar.me): R$ ${interest.toFixed(2)}
Total Pago (Pagar.me): R$ ${paidAmount.toFixed(2)}

Cliente: ${firstName} ${lastName}
Email: ${email} | Tel: ${phone}

Endereço: ${address.address1}, ${address.city}-${address.province_code}, ${
      address.zip
    }

Produtos:
${productsString}
`.trim();

    const contactId = await findOrCreateContact({
      firstName,
      lastName,
      email,
      phone,
      address,
    });

    const cityValue = address.city || "";
    const stateId = getBitrixStateId(address);
    const orderValue =
      paidAmount > 0 ? paidAmount : Number(order.total_price) ?? 0;

    codRastreio = codRastreio?.replace("Cód. de Rastreamento:", "").trim();

    const fields = {
      TITLE: `Pedido Shopify ${order.name}`,
      CATEGORY_ID,
      STAGE_ID: mapStage(order),
      OPPORTUNITY: orderValue,
      CURRENCY_ID: order.currency || "BRL",
      IS_MANUAL_OPPORTUNITY: "Y",
      ORIGINATOR_ID: "SHOPIFY",
      ORIGIN_ID: String(order.id),
      [FIELD_SHOPIFY_ID]: String(order.id),
      ...(contactId ? { CONTACT_ID: contactId } : {}),
      ADDRESS: `${address.address1} ${address.address2 || ""}`.trim(),
      ADDRESS_CITY: address.city || "",
      ADDRESS_POSTAL_CODE: address.zip || "",
      [FIELD_CITY]: cityValue,
      ...(stateId ? { [FIELD_STATE]: stateId } : {}),
      [FIELD_SELLER]: vendedorValue,
      [FIELD_INTEREST_PAID]: interest ?? null,
      [FIELD_COD_RASTREIO]: codRastreio ?? null,
      COMMENTS: commentsText,
      ...(assignedById ? { ASSIGNED_BY_ID: assignedById } : {}),
    };

    // Lógica principal de Criação/Atualização
    const existingDealId = await findDealByShopifyId(order.id);
    let dealId = existingDealId;

    if (existingDealId) {
      console.log(
        `[ATUALIZAR] Deal encontrado: ${existingDealId}. Atualizando...`
      );
      await axios.post(bitrixUrl("crm.deal.update"), {
        id: existingDealId,
        fields,
      });
    } else {
      console.log("[CRIAR] Deal não encontrado. Criando novo...");
      const r = await axios.post(bitrixUrl("crm.deal.add"), { fields });
      dealId = r.data.result;
      console.log(`[CRIADO] Novo Deal ID: ${dealId}`);
    }

    if (dealId) {
      await setDealProducts(dealId, order.line_items || []);
    }
  } catch (err) {
    console.error(`Erro ao processar ID ${order.id}:`, err.message);
  }
}

app.post("/webhook", (req, res) => {
  res.status(200).send("OK");

  const order = req.body;
  const orderId = String(order.id);

  console.log(`[WEBHOOK] Recebido para ID ${orderId}`);

  const currentQueue = orderQueues.get(orderId) || Promise.resolve();

  const nextTask = currentQueue
    .then(() => processOrderWebhook(order))
    .catch((err) => console.error(`Erro na fila do ID ${orderId}:`, err))
    .finally(() => {
      if (orderQueues.get(orderId) === nextTask) {
        orderQueues.delete(orderId);
        console.log(`[FILA] Fila vazia para ID ${orderId}. Limpo.`);
      }
    });

  orderQueues.set(orderId, nextTask);
});

app.post("/webhooks/bonifiq", async (req, res) => {
  try {
    const root = req.body;

    const data = root.Payload || {};
    console.log("root", JSON.stringify(root, null, 2));

    const customer = data.Customer || {};
    const balance = data.PointsBalance || {};
    const customerEmail = customer.Email;
    const points = balance?.PointsBalance;

    const currentBalance = (points * 0.05).toFixed(2);

    if (!customerEmail || currentBalance === undefined) {
      console.warn(
        `Payload ignorado. Email: ${customerEmail}, Saldo: ${currentBalance}`
      );
      return res
        .status(200)
        .send({ status: "ignored", reason: "missing_data" });
    }

    const bitrixContact = await findContactByEmail(customerEmail);

    if (!bitrixContact) {
      console.log(
        `Contato não encontrado no Bitrix para o email: ${customerEmail}. Ignorando.`
      );
      return res
        .status(200)
        .send({ status: "ignored", reason: "contact_not_found_in_crm" });
    }

    // --- NOVA LÓGICA DE EXPIRAÇÃO ---
    let expirationText = "";

    // Consulta a API da Bonifiq para pegar detalhes de expiração
    const bonifiqData = await getBonifiqCustomerData(customerEmail);

    if (
      bonifiqData &&
      bonifiqData.PointsToExpire &&
      bonifiqData.PointsToExpire.length > 0
    ) {
      const lines = bonifiqData.PointsToExpire.map((item) => {
        const valReais = (item.Points * 0.05).toFixed(2);
        const points = item.Points;
        const dateObj = new Date(item.When);
        const dateStr = dateObj.toLocaleDateString("pt-BR", {
          timeZone: "UTC",
        });

        return `Pontos: ${points} R$ ${valReais} em ${dateStr}`;
      });

      expirationText = lines.join(" || ");
    }
    // --------------------------------
    console.log("algoo", bonifiqData, bonifiqData.PointsToExpire);
    await updateBitrixCashback(
      bitrixContact.ID,
      currentBalance,
      expirationText
    );

    console.log(
      `Sucesso! Bitrix ID ${bitrixContact.ID} atualizado para R$ ${currentBalance}. Expirações processadas.`
    );

    return res
      .status(200)
      .send({ status: "success", bitrix_id: bitrixContact.ID });
  } catch (error) {
    console.error("Erro fatal no processamento:", error.message);
    return res.status(500).send({ error: "Internal Server Error" });
  }
});

app.post("/webhooks/shopify/enroll", async (req, res) => {
  res.status(200).send("Processing Enrollment");

  try {
    const order = req.body;
    console.log(
      `[Eduvem] Iniciando processamento pedido: ${order.name} (${order.id})`
    );

    const customer = order.customer || {};
    const noteAttributes = order.note_attributes || [];

    const cpfAttr = noteAttributes.find(
      (attr) =>
        attr.name.toLowerCase() === "cpf" || attr.name.toLowerCase() === "cnpj"
    );
    const studentDocument = cpfAttr
      ? cpfAttr.value
      : customer?.tax_exemptions?.[0] || "";

    const studentData = {
      fullName: `${customer.first_name} ${customer.last_name}`.trim(),
      email: customer.email,
      document: studentDocument.replace(/\D/g, ""),
    };

    if (!studentData.email) {
      console.warn("[Eduvem] Email não encontrado. Abortando.");
      return;
    }

    for (const item of order.line_items) {
      const productId = item.product_id;

      const { courseClassUUID, teamUUID } = await getEduvemDataFromProduct(
        productId
      );

      if (courseClassUUID) {
        console.log(
          `[Eduvem] Produto "${item.title}" é SALA: ${courseClassUUID}. Matriculando...`
        );
        await enrollStudent(studentData, courseClassUUID);
      }

      if (teamUUID) {
        console.log(
          `[Eduvem] Produto "${item.title}" é GRUPO: ${teamUUID}. Adicionando...`
        );
        await enrollStudentInTeam(studentData, teamUUID);
      }

      if (!courseClassUUID && !teamUUID) {
        console.log(
          `[Eduvem] Produto "${item.title}" (ID: ${productId}) não possui metafields de integração.`
        );
      }
    }
  } catch (error) {
    console.error("[Eduvem] Erro fatal no webhook:", error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
