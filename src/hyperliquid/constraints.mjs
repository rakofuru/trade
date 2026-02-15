function toCanonicalNumberString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  let s = String(value).trim();
  if (!s) {
    return "";
  }
  if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s.startsWith("-")) {
    return "";
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return "";
  }
  if (s.includes(".")) {
    s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  s = s.replace(/^0+(?=\d)/, "");
  if (s.startsWith(".")) {
    s = `0${s}`;
  }
  return s || "0";
}

export function countDecimalPlaces(value) {
  const s = toCanonicalNumberString(value);
  if (!s || !s.includes(".")) {
    return 0;
  }
  return s.length - s.indexOf(".") - 1;
}

export function countSignificantFigures(value) {
  const s = toCanonicalNumberString(value);
  if (!s) {
    return 0;
  }
  const compact = s.replace(".", "");
  const noLead = compact.replace(/^0+/, "");
  return noLead.length;
}

export function isIntegerPrice(value) {
  const s = toCanonicalNumberString(value);
  return Boolean(s) && !s.includes(".");
}

export function validatePerpPriceString(px, szDecimals) {
  const s = toCanonicalNumberString(px);
  if (!s || !(Number(s) > 0)) {
    return { ok: false, reason: "price_non_positive", value: s };
  }
  const decimals = countDecimalPlaces(s);
  const sigFigs = countSignificantFigures(s);
  const maxDecimals = Math.max(0, 6 - Number(szDecimals || 0));
  const integer = isIntegerPrice(s);

  if (decimals > maxDecimals) {
    return {
      ok: false,
      reason: "price_too_many_decimals",
      value: s,
      decimals,
      maxDecimals,
      sigFigs,
      integer,
    };
  }

  // Hyperliquid allows any integer price regardless of sig figs.
  if (!integer && sigFigs > 5) {
    return {
      ok: false,
      reason: "price_too_many_sigfigs",
      value: s,
      decimals,
      maxDecimals,
      sigFigs,
      integer,
    };
  }

  return {
    ok: true,
    value: s,
    decimals,
    maxDecimals,
    sigFigs,
    integer,
  };
}

export function validateSizeString(sz, szDecimals) {
  const s = toCanonicalNumberString(sz);
  if (!s || !(Number(s) > 0)) {
    return { ok: false, reason: "size_non_positive", value: s };
  }
  const decimals = countDecimalPlaces(s);
  const maxDecimals = Math.max(0, Number(szDecimals || 0));
  if (decimals > maxDecimals) {
    return {
      ok: false,
      reason: "size_too_many_decimals",
      value: s,
      decimals,
      maxDecimals,
    };
  }
  return { ok: true, value: s, decimals, maxDecimals };
}

export function validatePerpOrderWire({ px, sz, szDecimals, triggerPx = null }) {
  const price = validatePerpPriceString(px, szDecimals);
  if (!price.ok) {
    return {
      ok: false,
      reason: price.reason,
      detail: {
        field: "px",
        ...price,
      },
    };
  }
  if (triggerPx !== null && triggerPx !== undefined) {
    const trigger = validatePerpPriceString(triggerPx, szDecimals);
    if (!trigger.ok) {
      return {
        ok: false,
        reason: `trigger_${trigger.reason}`,
        detail: {
          field: "triggerPx",
          ...trigger,
        },
      };
    }
  }
  const size = validateSizeString(sz, szDecimals);
  if (!size.ok) {
    return {
      ok: false,
      reason: size.reason,
      detail: {
        field: "sz",
        ...size,
      },
    };
  }
  return {
    ok: true,
    detail: {
      price,
      triggerPx: triggerPx !== null && triggerPx !== undefined
        ? validatePerpPriceString(triggerPx, szDecimals)
        : null,
      size,
    },
  };
}

function quantizeToDecimals(value, decimals, mode = "nearest") {
  const factor = 10 ** Math.max(0, Number(decimals || 0));
  const scaled = Number(value) * factor;
  let units;
  if (mode === "floor") {
    units = Math.floor(scaled + 1e-12);
  } else if (mode === "ceil") {
    units = Math.ceil(scaled - 1e-12);
  } else {
    units = Math.round(scaled);
  }
  return units / factor;
}

export function normalizePerpPriceForWire({ px, szDecimals, mode = "nearest" }) {
  const input = Number(px);
  if (!(input > 0)) {
    return {
      ok: false,
      reason: "price_non_positive",
      value: String(px ?? ""),
      normalized: null,
      maxDecimals: Math.max(0, 6 - Number(szDecimals || 0)),
    };
  }

  const maxDecimals = Math.max(0, 6 - Number(szDecimals || 0));
  for (let decimals = maxDecimals; decimals >= 0; decimals -= 1) {
    const quantized = quantizeToDecimals(input, decimals, mode);
    const candidate = toCanonicalNumberString(quantized.toFixed(decimals));
    if (!candidate) {
      continue;
    }
    const check = validatePerpPriceString(candidate, szDecimals);
    if (check.ok) {
      return {
        ok: true,
        normalized: candidate,
        mode,
        maxDecimals,
        ...check,
      };
    }
  }

  // Last fallback: valid integer price is accepted regardless of sig figs.
  const roundedInteger = Math.max(1, Math.round(input));
  const integerCandidate = toCanonicalNumberString(String(roundedInteger));
  const integerCheck = validatePerpPriceString(integerCandidate, szDecimals);
  if (integerCheck.ok) {
    return {
      ok: true,
      normalized: integerCandidate,
      mode,
      maxDecimals,
      ...integerCheck,
    };
  }

  return {
    ok: false,
    reason: "price_normalization_failed",
    value: String(px ?? ""),
    normalized: null,
    maxDecimals,
  };
}
