import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Lê o webhook do Bitrix das variáveis de ambiente do Render
const rawBase = process.env.BITRIX_WEBHOOK_BASE;

// segurança extra: garante que tem exatamente 1 barra no final
const BITRIX_WEBHOOK_BASE = (rawBase || "").replace(/\/+$/, "") + "/";

if (!rawBase) {
  console.error("ERRO: BITRIX_WEBHOOK_BASE não definido nas variáveis de ambiente");
}

// helper pra montar URL correta do método REST
function bitrixUrl(method) {
  const url = `${BITRIX_WEBHOOK_BASE}${method}.json`;
  console.log("URL Bitrix usada:", url);
  return url;
}

// helper para pegar o endereço "principal" do pedido
function getPrimaryAddress(order) {
  const customer = order.customer || {};
  return (
    order.shipping_address ||
    order.billing_address ||
    customer.default_address || {
      address1: "",
      address2: "",
      city: "",
      province: "",
      country: "",
      zip: "",
    }
  );
}

// formata um texto bonitinho pros comentários do negócio
function buildOrderComment(order) {
  const customer = order.customer || {};
  const address = getPrimaryAddress(order);

  const itens =
    (order.line_items || [])
      .map(
        (item) =>
          `- ${item.quantity}x ${item.title} (SKU: ${item.sku || "—"}) - R$ ${item.price}`
      )
      .join("\n") || "Nenhum item listado.";

  const endereco = address.address1
    ? `${address.address1 || ""} ${address.address2 || ""} - ${address.city || ""} - ${
        address.province || ""
      } - ${address.country || ""} - CEP: ${address.zip || ""}`
    : "Não informado.";

  return `
Pedido Shopify
ID: ${order.id}
Número: ${order.name}
Status financeiro: ${order.financial_status || "N/A"}
Status de envio: ${order.fulfillment_status || "N/A"}
Total: ${order.total_price || "N/A"} ${order.currency || ""}

Cliente:
Nome: ${customer.first_name || ""} ${customer.last_name || ""}
Email: ${order.email || customer.email || "Não informado"}
Telefone: ${
    customer.phone ||
    (order.billing_address && order.billing_address.phone) ||
    (order.shipping_address && order.shipping_address.phone) ||
    (customer.default_address && customer.default_address.phone) ||
    order.phone ||
    "Não informado"
  }

Endereço:
${endereco}

Itens:
${itens}
`.trim();
}

// cria um contato no Bitrix (com telefone + endereço)
async function createBitrixContact(order) {
  const customer = order.customer || {};
  const firstName = customer.first_name || (customer.name || "").split(" ")[0] || "Cliente";
  const lastName =
    customer.last_name || (customer.name || "").split(" ").slice(1).join(" ") || "";

  const email = order.email || customer.email || "";

  // Procurar telefone em todos os lugares possíveis na Shopify
  const phone =
    customer.phone ||
    (order.billing_address && order.billing_address.phone) ||
    (order.shipping_address && order.shipping_address.phone) ||
    (customer.default_address && customer.default_address.phone) ||
    order.phone ||
    "";

  console.log("Telefone encontrado na Shopify:", phone || "(nenhum)");

  const address = getPrimaryAddress(order);

  const fields = {
    NAME: firstName,
    LAST_NAME: lastName,
    OPENED: "Y",
    TYPE_ID: "CLIENT",
    SOURCE_ID: "WEB",
    // endereço mapeado pros campos padrão do Bitrix
    ADDRESS: [address.address1, address.address2].filter(Boolean).join(" "),
    ADDRESS_CITY: address.city || "",
    ADDRESS_REGION: address.province || "",
    ADDRESS_PROVINCE: address.province || "",
    ADDRESS_COUNTRY: address.country || "",
    ADDRESS_POSTAL_CODE: address.zip || "",
  };

  if (email) {
    fields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
  }

  if (phone) {
    fields.PHONE = [{ VALUE: phone, VALUE_TYPE: "WORK" }];
  }

  try {
    const resp = await axios.post(bitrixUrl("crm.contact.add"), {
      fields,
      params: { REGISTER_SONET_EVENT: "Y" },
    });

    console.log("Contato Bitrix criado:", resp.data);
    if (resp.data && resp.data.result) {
      return resp.data.result; // ID do contato
    }
  } catch (err) {
    console.error("Erro ao criar contato no Bitrix:");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error(err.message);
    }
  }

  return null; // segue sem contato vinculado
}

// cria o negócio no Bitrix
async function createBitrixDeal(order, contactId = null) {
  const comment = buildOrderComment(order);

  const fields = {
    TITLE: `Pedido Shopify ${order.name || order.id}`,
    OPPORTUNITY: order.total_price ? Number(order.total_price) : 0,
    CURRENCY_ID: order.currency || "BRL",
    COMMENTS: comment,
    ORIGIN_ID: "SHOPIFY",
    ORIGINATOR_ID: String(order.id),
  };

  // Se quiser usar um pipeline/estágio específico, configure via env no Render:
  // BITRIX_CATEGORY_ID (ID do pipeline) e BITRIX_STAGE_ID (ID da etapa)
  if (process.env.BITRIX_CATEGORY_ID) {
    fields.CATEGORY_ID = Number(process.env.BITRIX_CATEGORY_ID);
  }

  if (process.env.BITRIX_STAGE_ID) {
    fields.STAGE_ID = process.env.BITRIX_STAGE_ID;
  }

  if (contactId) {
    fields.CONTACT_ID = contactId;
  }

  const response = await axios.post(bitrixUrl("crm.deal.add"), {
    fields,
    params: { REGISTER_SONET_EVENT: "Y" },
  });

  console.log("Resposta Bitrix (deal):", response.data);

  if (response.data.error) {
    throw new Error("Erro Bitrix (deal): " + response.data.error_description);
  }

  return response.data.result; // ID do negócio
}

// adiciona produtos do pedido ao negócio
async function setDealProducts(order, dealId) {
  const items = order.line_items || [];

  if (!items.length) {
    console.log("Pedido sem itens para adicionar ao negócio.");
    return;
  }

  const rows = items.map((item) => ({
    PRODUCT_NAME: item.title,
    QUANTITY: item.quantity || 1,
    PRICE: item.price ? Number(item.price) : 0,
    // Se quiser vincular a produtos do catálogo do Bitrix, use PRODUCT_ID aqui
  }));

  const resp = await axios.post(bitrixUrl("crm.deal.productrows.set"), {
    id: dealId,
    rows,
  });

  console.log("Resposta Bitrix (productrows.set):", resp.data);

  if (resp.data.error) {
    console.error("Erro Bitrix ao definir produtos:", resp.data);
  }
}

// Rota que a Shopify chama
app.post("/webhook", async (req, res) => {
  try {
    const order = req.body;
    console.log("Pedido recebido da Shopify:", order.id, `#${order.name}`);

    // 1) Cria contato com telefone + endereço
    const contactId = await createBitrixContact(order);

    // 2) Cria negócio vinculado ao contato
    const dealId = await createBitrixDeal(order, contactId);

    // 3) Adiciona produtos ao negócio
    await setDealProducts(order, dealId);

    res.status(200).send("OK");
  } catch (err) {
    console.error("Erro integração Shopify → Bitrix:");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
      res
        .status(500)
        .send(
          "Erro ao integrar (Bitrix): " +
            (err.response.data.error_description || err.response.data.error || "Erro desconhecido")
        );
    } else {
      console.error(err.message);
      res.status(500).send("Erro ao integrar");
    }
  }
});

// Porta obrigatória no Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor ouvindo na porta", PORT);
});
