import axios from "axios";

import {
  STAGE_NEW,
  STAGE_WON,
  STAGE_LOST,
  STATE_MAP,
  FIELD_SHOPIFY_ID,
  BITRIX_URL,
  BITRIX_FIELD,
  BITRIX_WEBHOOK_BASE,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_DOMAIN,
} from "./constants.js";

let usersCache = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 1000 * 60 * 120;
const API_VERSION = "2025-10";

const EDUVEM_API_URL =
  "https://smartgr.eduvem.com/api/integrations/courseClasses";

export function bitrixUrl(method) {
  return `${BITRIX_WEBHOOK_BASE}${method}.json`;
}

export function mapStage(order) {
  const fs = (order.financial_status || "").toLowerCase();
  if (fs === "paid" || fs === "partially_paid") return STAGE_WON;
  if (fs === "refunded" || fs === "voided") return STAGE_LOST;
  return STAGE_NEW;
}

export function getBitrixStateId(address) {
  const uf = (address.province_code || address.province || "")
    .toUpperCase()
    .trim();
  return STATE_MAP[uf] || null;
}

export async function getShopifyMetafields(orderId) {
  try {
    if (!SHOPIFY_ACCESS_TOKEN) return { interest: 0, paidAmount: 0 };

    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/orders/${orderId}/metafields.json`;

    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });

    const metafields = response.data.metafields || [];

    const interestMeta = metafields.find(
      (m) => m.namespace === "pagarme" && m.key === "interest_cents"
    );
    const paidMeta = metafields.find(
      (m) => m.namespace === "pagarme" && m.key === "paid_amount_cents"
    );

    const interest = interestMeta ? Number(interestMeta.value) / 100 : 0;
    const paidAmount = paidMeta ? Number(paidMeta.value) / 100 : 0;

    console.log(
      `Metafields encontrados - Juros: ${interest}, Total Pago: ${paidAmount}`
    );

    return { interest, paidAmount };
  } catch (error) {
    console.error(
      "Erro ao buscar Metafields Shopify:",
      error.response?.data || error.message
    );

    return { interest: 0, paidAmount: 0 };
  }
}

export async function findDealByShopifyId(orderId) {
  try {
    const resp = await axios.post(bitrixUrl("crm.deal.list"), {
      filter: { [FIELD_SHOPIFY_ID]: String(orderId) },
      select: ["ID"],
    });
    return resp.data.result?.[0]?.ID || null;
  } catch (e) {
    console.error("Erro busca deal:", e.message);
    return null;
  }
}

export async function findOrCreateContact({
  firstName,
  lastName,
  email,
  phone,
  address,
}) {
  try {
    let contact = null;

    if (email) {
      const r = await axios.post(bitrixUrl("crm.contact.list"), {
        filter: { EMAIL: email },
        select: ["ID"],
      });
      contact = r.data.result?.[0];
    }

    if (!contact && phone) {
      const r = await axios.post(bitrixUrl("crm.contact.list"), {
        filter: { PHONE: phone },
        select: ["ID"],
      });
      contact = r.data.result?.[0];
    }

    if (contact) {
      const updateFields = {};
      if (email) updateFields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
      if (phone) updateFields.PHONE = [{ VALUE: phone, VALUE_TYPE: "MOBILE" }];

      if (Object.keys(updateFields).length > 0) {
        await axios
          .post(bitrixUrl("crm.contact.update"), {
            id: contact.ID,
            fields: updateFields,
          })
          .catch((e) => console.error("Erro update contato", e.message));
      }
      return contact.ID;
    }

    const fields = {
      NAME: firstName || "Cliente",
      LAST_NAME: lastName || "Shopify",
      OPENED: "Y",
      TYPE_ID: "CLIENT",
      EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
      PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "MOBILE" }] : [],
    };
    if (address) {
      fields.ADDRESS = `${address.address1} ${address.address2 || ""}`.trim();
      fields.ADDRESS_CITY = address.city;
      fields.ADDRESS_POSTAL_CODE = address.zip;
      fields.ADDRESS_PROVINCE = address.province_code;
    }

    const createResp = await axios.post(bitrixUrl("crm.contact.add"), {
      fields,
    });
    return createResp.data.result;
  } catch (e) {
    console.error("Erro criar contato:", e.message);
    return null;
  }
}

export async function setDealProducts(dealId, lineItems) {
  if (!dealId || !lineItems?.length) return;
  try {
    const rows = lineItems.map((item) => ({
      PRODUCT_NAME: item.title || item.name || "Produto Shopify",
      PRICE: item.price ? Number(item.price) : 0,
      QUANTITY: item.quantity ? Number(item.quantity) : 1,
    }));
    await axios.post(bitrixUrl("crm.deal.productrows.set"), {
      id: dealId,
      rows,
    });
  } catch (e) {
    console.error("Erro produtos:", e.message);
  }
}

export async function findContactByEmail(email) {
  try {
    const response = await axios.get(`${BITRIX_URL}/crm.contact.list`, {
      params: {
        filter: { EMAIL: email },
        select: ["ID", "NAME", "LAST_NAME", "EMAIL"],
      },
    });

    if (response.data.result && response.data.result.length > 0) {
      return response.data.result[0];
    }
    return null;
  } catch (error) {
    console.error("Erro ao buscar contato no Bitrix:", error.message);
    throw error;
  }
}

export async function updateBitrixCashback(contactId, newBalance) {
  try {
    const fields = {};
    fields[BITRIX_FIELD] = newBalance;

    const response = await axios.post(`${BITRIX_URL}/crm.contact.update`, {
      id: contactId,
      fields: fields,
    });

    return response.data;
  } catch (error) {
    console.error(`Erro ao atualizar contato ${contactId}:`, error.message);
    throw error;
  }
}

export async function getBitrixUserIdByName(fullName) {
  if (!fullName) return null;

  const now = Date.now();

  if (!usersCache || now - lastCacheUpdate > CACHE_TTL) {
    console.log("Cache de usuários vazio ou expirado. Buscando no Bitrix...");
    usersCache = {};

    let start = 0;
    let hasNext = true;

    try {
      while (hasNext) {
        const response = await axios.post(bitrixUrl("user.get"), {
          start: start,
        });

        const result = response.data.result || [];

        result.forEach((user) => {
          const name = user.NAME || "";
          const lastName = user.LAST_NAME || "";
          const completeName = `${name} ${lastName}`.trim().toUpperCase();

          if (completeName) {
            usersCache[completeName] = user.ID;
          }
        });

        if (response.data.next) {
          start = response.data.next;
        } else {
          hasNext = false;
        }
      }

      lastCacheUpdate = now;
      console.log(
        `Cache de usuários atualizado. Total mapeado: ${
          Object.keys(usersCache).length
        }`
      );
    } catch (e) {
      console.error("Erro ao buscar usuários do Bitrix:", e.message);
      return null;
    }
  }

  const normalizedSearch = fullName.trim().toUpperCase();
  const foundId = usersCache[normalizedSearch];

  if (foundId) {
    console.log(`Vendedor encontrado: "${fullName}" -> ID ${foundId}`);
    return foundId;
  } else {
    console.warn(`Vendedor não encontrado no Bitrix: "${fullName}"`);
    return null;
  }
}

async function getEduvemClassIdFromProduct(productId) {
  try {
    const url = `https://${process.env.SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products/${productId}/metafields.json`;

    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });

    const metafields = response.data.metafields;

    const targetMetafield = metafields.find(
      (m) => m.namespace === "custom" && m.key === "id_sala_eduvem"
    );

    return targetMetafield ? targetMetafield.value : null;
  } catch (error) {
    console.error(
      `Erro ao buscar metafield para produto ${productId}:`,
      error.message
    );
    return null;
  }
}

export async function enrollStudent(student, courseUUID) {
  try {
    const payload = {
      courseClassUUID: courseUUID,
      fullName: student.fullName,
      email: student.email,
      options: {
        purchasingEntityName: "Shopify Store",
        enrollments: 1,
        document: student.document,
      },
    };

    const authHeader = process.env.EDUVEM_API_TOKEN.startsWith("Bearer")
      ? process.env.EDUVEM_API_TOKEN
      : `Bearer ${process.env.EDUVEM_API_TOKEN}`;

    const response = await axios.post(EDUVEM_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.EDUVEM_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`[Eduvem] SUCESSO! Aluno ${student.email} matriculado.`);
    return response.data;
  } catch (err) {
    const errorMsg = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error(`[Eduvem] FALHA ao matricular: ${errorMsg}`);
  }
}
