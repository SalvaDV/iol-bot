const BASE = 'https://dolarapi.com/v1/dolares';

async function fetchTipo(tipo) {
  const res = await fetch(`${BASE}/${tipo}`);
  if (!res.ok) return null;
  return res.json();
}

export async function getDolarData() {
  try {
    const [oficial, mep, ccl, blue] = await Promise.all([
      fetchTipo('oficial'),
      fetchTipo('bolsa'),
      fetchTipo('contadoconliqui'),
      fetchTipo('blue'),
    ]);

    const brechaMEP = oficial?.venta && mep?.venta
      ? ((mep.venta - oficial.venta) / oficial.venta * 100)
      : null;
    const brechaCCL = oficial?.venta && ccl?.venta
      ? ((ccl.venta - oficial.venta) / oficial.venta * 100)
      : null;

    return { oficial: oficial?.venta, mep: mep?.venta, ccl: ccl?.venta, blue: blue?.venta, brechaMEP, brechaCCL };
  } catch {
    return null;
  }
}

export function formatDolarContext(d) {
  if (!d) return 'Sin datos de dólar disponibles.';
  const fmt = (n) => n != null ? `$${n.toLocaleString('es-AR')}` : '?';
  const brecha = (b) => b != null ? ` (brecha ${b.toFixed(1)}% vs oficial)` : '';
  return [
    `• Oficial: ${fmt(d.oficial)}`,
    `• MEP (bolsa): ${fmt(d.mep)}${brecha(d.brechaMEP)}`,
    `• CCL: ${fmt(d.ccl)}${brecha(d.brechaCCL)}`,
    `• Blue: ${fmt(d.blue)}`,
  ].join('\n');
}
