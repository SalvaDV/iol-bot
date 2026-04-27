const BASE = 'https://api.invertironline.com';

export async function getToken() {
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: process.env.IOL_USER,
      password: process.env.IOL_PASS,
      grant_type: 'password',
    }),
  });
  if (!res.ok) throw new Error(`IOL auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function iolGet(token, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IOL GET ${path} failed: ${res.status} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function getPortfolio(token) {
  return iolGet(token, '/api/v2/portafolio/argentina');
}

export async function getCuenta(token) {
  return iolGet(token, '/api/v2/estadocuenta');
}

export async function getCotizacion(token, simbolo, mercado = null) {
  const mercados = mercado ? [mercado] : ['bcba', 'nysenasd'];
  let lastErr;
  for (const m of mercados) {
    try {
      const data = await iolGet(token, `/api/${m}/Titulos/${simbolo}/cotizacion`);
      data._mercado = m;
      return data;
    } catch (e) {
      lastErr = e;
      if (!e.message.includes('400') && !e.message.includes('404')) throw e;
    }
  }
  throw lastErr;
}

/** Extrae el precio más confiable de una respuesta de getCotizacion */
export function extractPrecio(cot) {
  // Campos explícitos en orden de preferencia
  const candidate = cot.ultimoPrecio ?? cot.ultimo ?? cot.precioActual ?? cot.precio ?? cot.cotizacion ?? cot.puntas?.[0]?.precioCompra ?? null;
  if (candidate && candidate > 0) return candidate;
  // Fallback: buscar el primer campo numérico > 0 que parezca un precio (entre 0.01 y 10_000_000)
  for (const val of Object.values(cot)) {
    if (typeof val === 'number' && val > 0.01 && val < 10_000_000) return val;
  }
  return null;
}

export async function getHistorial(token, simbolo, mercado = 'bcba') {
  const fechaDesde = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const fechaHasta = new Date().toISOString().slice(0, 10);
  // Probar los dos formatos conocidos del endpoint histórico
  const paths = [
    `/api/${mercado}/Titulos/${simbolo}/cotizacion/seriehistorica/${fechaDesde}/${fechaHasta}/sinAjustar`,
    `/api/v2/cotizaciones/titulos/${mercado}/${simbolo}/historial?fechaDesde=${fechaDesde}&fechaHasta=${fechaHasta}&ajustada=sinAjustar`,
  ];
  let lastErr;
  for (const path of paths) {
    try {
      return await iolGet(token, path);
    } catch (e) {
      lastErr = e;
      if (!e.message.includes('400') && !e.message.includes('404')) throw e;
    }
  }
  throw lastErr;
}

export async function getOrden(token, numero) {
  return iolGet(token, `/api/v2/operar/v2/operaciones/${numero}`);
}

export async function crearOrden(token, { mercado = 'bcba', simbolo, cantidad, precio, operacion, plazo = 't2' }) {
  const res = await fetch(`${BASE}/api/v2/operar/v2/operaciones`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mercado, simbolo, cantidad, precio, operacion, plazo,
      tipoOrden: 'precioLimite',
      validez: 'delDia',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`crearOrden failed ${res.status}: ${body}`);
  }
  return res.json();
}
