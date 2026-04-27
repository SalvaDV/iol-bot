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
  if (!res.ok) throw new Error(`IOL GET ${path} failed: ${res.status}`);
  return res.json();
}

export async function getPortfolio(token) {
  return iolGet(token, '/api/v2/portafolio/argentina');
}

export async function getCuenta(token) {
  return iolGet(token, '/api/v2/estadocuenta');
}

export async function getCotizacion(token, simbolo) {
  return iolGet(token, `/api/v2/cotizaciones/titulos/bcba/${simbolo}`);
}

export async function getHistorial(token, simbolo) {
  const fechaDesde = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const fechaHasta = new Date().toISOString().slice(0, 10);
  return iolGet(token,
    `/api/v2/cotizaciones/titulos/bcba/${simbolo}/historial?fechaDesde=${fechaDesde}&fechaHasta=${fechaHasta}&ajustada=sinAjustar`
  );
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
