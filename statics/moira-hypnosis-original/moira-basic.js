
globalThis.__MOIRA_FN = window.__MOIRA_FN = async function moira(
  t,
  o,
  i,
  {
    gridSize: a,
    bgColor: n,
    fontWeight: r,
    simplexHash: l,
    // canvasOptions: s,
    padding: _pp,
    seed: c
  }
  = {}
) {
  const __MOIRA_OPT = globalThis.__MOIRA_OPT || window.__MOIRA_OPT;

  function eac(t, e, o, i, a) {
    return Math.abs(e - o) < Number.EPSILON ? i : (t - e) / (o - e) * (a - i) + i
  }

  if (!t || !o || !i) throw new Error('required args');
  const d = l ||
  '0xbf30523b5fbf36d0a5db4679782d73e6a0b4f169d679fe504629c09217a6356d',
  h = await __MOIRA_OPT?.l(d);
  if (!h) throw new Error('failed to load simplex');
  const p = h.createNoise3D(c);
  a = a ||
  24,
  t(
    (
      () => {
        const t = 1 / (2 * a);
        return ({
          context: l,
          width: s,
          height: f,
          playhead: c
        }) => {
          l.clearRect(0, 0, s, f),
          l.fillStyle = n ||
          '#001',
          l.fillRect(0, 0, s, f);
          const d = Math.sin(2 * c * Math.PI),
          h = (_pp ?? 0.15) * f,
          x = (f - 2 * h) / a;
          for (let n = 0; n <= a; n++) for (let c = 0; c <= a; c++) {
            const b = p(n * t, c * t, d),
            u = Math.floor(eac(b, - 1, 1, 0, o.length - 1)),
            g = [
              eac(n, 0, a, h, s - h),
              eac(c, 0, a, h, f - h)
            ];
            l.font = `${ r ||
            400 } ${ 0.75 * x }px 'monospace'`,
            l.textAlign = 'center',
            l.textBaseline = 'middle',
            l.fillStyle = i,
            l.fillText(o[u], g[0], g[1])
          }
        }
      }
    ),
    {
      animate: !0,
      duration: 8,
      scaleToView: !0,
      scaleToFit: !0,
      fps: 60,

      ...(navigator.userAgent.match(
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|WPDesktop|IEMobile|Opera Mini/i,
      )
        ? __MOIRA_OPT?.mobileDimensions || { dimensions: [1200, 1200] }
        : __MOIRA_OPT?.desktopDimensions || { dimensions: [770, 770] }),

      canvas: __MOIRA_OPT?.el || document.querySelector("#moira-canvas"),
    }
  )
}
