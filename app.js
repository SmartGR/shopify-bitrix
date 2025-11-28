import express from "express";
import axios from "axios";

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

    const noteAttributes = order.note_attributes || [];
    const affiliateObj = noteAttributes.find(
      (attr) => attr.name === "Affiliate"
    );
    const vendedorValue = affiliateObj ? affiliateObj.value : "";

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
    };

    console.log("Payload Deal:", JSON.stringify(fields, null, 2));

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
  console.log("Webhook Bonifiq recebido:", JSON.stringify(req.body));

  try {
    const payload = req.body;

    const customerEmail = payload.customer
      ? payload.customer.email
      : payload.email;
    const currentBalance = payload.customer
      ? payload.customer.balance
      : payload.balance;

    if (!customerEmail || currentBalance === undefined) {
      console.warn("Payload ignorado: E-mail ou Saldo não encontrados.");
      return res
        .status(400)
        .send({ error: "Dados incompletos (email/balance)" });
    }

    console.log(
      `Processando: ${customerEmail} | Novo Saldo: ${currentBalance}`
    );

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
    console.error("Erro fatal no processamento:", error);
    return res.status(500).send({ error: "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
