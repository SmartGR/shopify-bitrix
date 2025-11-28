export const BITRIX_URL =
  process.env.BITRIX_WEBHOOK_URL ??
  "https://smartgr.bitrix24.com.br/rest/12/h0ah2vd1xnc0nncv";

export const rawBase =
  process.env.BITRIX_WEBHOOK_BASE ||
  "https://smartgr.bitrix24.com.br/rest/12/h0ah2vd1xnc0nncv/";
export const BITRIX_WEBHOOK_BASE = rawBase.replace(/\/+$/, "") + "/";

export const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
export const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

export const BITRIX_FIELD = "UF_CRM_1764326319407";

export const FIELD_SHOPIFY_ID = "UF_CRM_1763463761";
export const FIELD_CITY = "UF_CRM_68F66E44278DC";
export const FIELD_STATE = "UF_CRM_68F66E4434B01";
export const FIELD_SELLER = "UF_CRM_1764318998507";
export const FIELD_INTEREST_PAID = "UF_CRM_1764319334638";

export const CATEGORY_ID = 7;
export const STAGE_NEW = "C7:NEW";
export const STAGE_WON = "C7:WON";
export const STAGE_LOST = "C7:LOSE";

export const STATE_MAP = {
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
