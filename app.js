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
} from "./constants.js";

dotenv.config();

const app = express();
app.use(express.json());

if (!process.env.SHOPIFY_ACCESS_TOKEN)
  console.warn(
    "ALERTA: SHOPIFY_ACCESS_TOKEN não definido. Juros não serão processados."
  );

app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const order = req.body;
    console.log(`Webhook recebido. Pedido: ${order.name} (${order.id})`);

    const customer = order.customer || {};
    const address = order.shipping_address || order.billing_address || {};
    const email = customer.email || order.email || "";
    const phone = address.phone || customer.phone || order.phone || "";
    const firstName = address.first_name || customer.first_name || "";
    const lastName = address.last_name || customer.last_name || "";
    console.log("orderNote", order.note);
    const noteAttributes = order.note_attributes || [];
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

    const orderValue = paidAmount ?? Number(order.total_price) ?? 0;

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

      COMMENTS: commentsText,
      ...(assignedById ? { ASSIGNED_BY_ID: assignedById } : {}),
    };

    const existingDealId = await findDealByShopifyId(order.id);
    let dealId = existingDealId;

    if (existingDealId) {
      console.log(`Atualizando Deal ${existingDealId}...`);
      await axios.post(bitrixUrl("crm.deal.update"), {
        id: existingDealId,
        fields,
      });
    } else {
      console.log("Criando novo Deal...");
      const r = await axios.post(bitrixUrl("crm.deal.add"), { fields });
      dealId = r.data.result;
      console.log(`Deal criado: ${dealId}`);
    }

    if (dealId) {
      await setDealProducts(dealId, order.line_items || []);
    }
  } catch (err) {
    console.error("Erro Processamento Webhook:", err.message);
  }
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

    await updateBitrixCashback(bitrixContact.ID, currentBalance);

    console.log(
      `Sucesso! Bitrix ID ${bitrixContact.ID} atualizado para ${currentBalance}`
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
