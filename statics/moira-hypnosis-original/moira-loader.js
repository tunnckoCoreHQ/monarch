const __MOIRA_OPT = {
  s: `0x9e48663a8a451508c4968e85a45903727fcf81168ba745cf4d2f6ddb3e475b16`,
  m: `0x734dcf30eb1a5af5ab5dceb697aa21aa726ff76056e87d47e20dddc51831f52e`,
  l: globalThis.__MOIRA_LOAD,
  ...globalThis.__MOIRA_OPT,
};

__MOIRA_OPT.s = (await __MOIRA_OPT.l(__MOIRA_OPT.s)).default;
__MOIRA_OPT.m = (await __MOIRA_OPT.l(__MOIRA_OPT.m)).default;

__MOIRA_OPT.m(__MOIRA_OPT.s, __MOIRA_OPT.chars, {
  seed: () => __MOIRA_OPT.seed,
  padding: 0.03,
  importEthscription: globalThis.__MOIRA_LOAD,
  canvasOptions: {
    ...(navigator.userAgent.match(
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|WPDesktop|IEMobile|Opera Mini/i,
    )
      ? __MOIRA_OPT.mobileDimensions || { dimensions: [1200, 1200] }
      : __MOIRA_OPT.desktopDimensions || { dimensions: [770, 770] }),
    scaleToView: !0,
    scaleToFit: !0,
    canvas: __MOIRA_OPT.el || document.querySelector("#moira-canvas"),
  },
})

console.log('sssss', __MOIRA_OPT)
