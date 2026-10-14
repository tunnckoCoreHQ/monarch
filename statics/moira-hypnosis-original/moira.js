export function generateMoira(address, rarity) {
  if (typeof address !== "string") {
    throw new Error("addr must be set");
  }

  // function getRandomWithProbability(data, weights, distrCount = 10) {
  //   const createDistribution = (weights, size) => {
  //     const distribution = [];
  //     const sum = weights.reduce((a, b) => a + b);
  //     const quant = size / sum;
  //     for (let i = 0; i < weights.length; ++i) {
  //       const limit = quant * weights[i];
  //       for (let j = 0; j < limit; ++j) {
  //         distribution.push(i);
  //       }
  //     }
  //     return distribution;
  //   };
  //   const randomIndex = (distribution) => {
  //     const index = Math.floor(Math.random() * distribution.length);
  //     return distribution[index];
  //   };

  //   const distribution = createDistribution(weights, distrCount);

  //   return data[randomIndex(distribution)];
  //   // return randomItem(data, distribution);
  // }

  function getTimestamp() {
    let ts = (Math.floor(Date.now() / 1000) + "").split("").reverse();

    ts = [".", ...ts];
    ts[5] = ",";
    ts[ts.length - 1] = "_";

    return ts;
  }

  function pickRandom(data) {
    let total = 0;
    for (let i = 0; i < data.length; ++i) {
      total += data[i][1];
    }

    // Total in hand, we can now pick a random value akin to our
    // random index from before.
    const threshold = Math.random() * total;

    // Now we just need to loop through the main data one more time
    // until we discover which value would live within this
    // particular threshold. We need to keep a running count of
    // weights as we go, so let's just reuse the "total" variable
    // since it was already declared.
    total = 0;
    for (let i = 0; i < data.length - 1; ++i) {
      // Add the weight to our running total.
      total += data[i][1];

      // If this value falls within the threshold, we're done!
      if (total >= threshold) {
        return data[i][0];
      }
    }

    // Wouldn't you know it, we needed the very last entry!
    return data[data.length - 1][0];
  }

  let chroma;

  while (chroma === undefined || chroma < 0.1 || chroma > 0.45) {
    chroma = Math.random();
  }

  const hue = Math.floor(Math.random() * 360);
  const color = `oklch(76.42% ${chroma} ${hue})`;
  const sets = {
    symbols: [
      "~",
      ">",
      "@",
      "!",
      // "#",
      "$",
      // "%",
      "^",
      "&",
      "*",
      "(",
      "?",
      "<",
      ";",
      "&",
      "=",
      "+",
    ],
    arrows: ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"],
    circles: ["¤", "✳", "●", "◔", "○", "◕", "◐", "◑", "◒"],
    emojis: ["🚀", "😍", "😅", "z", "🥳", "😭", "🩷", "😢", "😈", "👀", "🥹"],
    squares: ["◧", "◪", "■", "◪", "□", "◩", "⬒", "◨", "⬓", "⬕"],
    address: address.slice(0, 15).split("").reverse(),
    moons: ["🌙", "🌖", "🌚", "🌙", "🌗", "🌘", "w", "🌒", "🌓", "🌔"],
    letters: ["0", "a", ";", "A", "q", ".", "C", "o", "D", "w", "G"],
    timestamp: getTimestamp(),
    // numbers: [".", "1", "2", "7", "_", "3", "8", "5", "6", "✳", "9"],
  };

  // const keysOrder = [
  //   "symbols",
  //   "arrows",
  //   "circles",
  //   "emojis",
  //   "squares",
  //   "address",
  //   "moons",
  //   "letters",
  //   "numbers",
  // ];

  // const weightsOrder = [
  //   0.00001, // symbols
  //   0.0005, // arrows
  //   0.001, // circles
  //   0.1, // emojis
  //   0.12, // squares
  //   0.15, // address
  //   0.1809, // moons
  //   0.21059, // letters
  //   0.237, // numbers
  // ];

  const rarityTable = rarity || [
    ["symbols", 100],
    ["arrows", 300],
    ["circles", 350],
    ["emojis", 500],
    ["squares", 550],
    ["address", 790],
    ["moons", 1010],
    ["letters", 2450],
    ["timestamp", 4000],
  ];

  const type = pickRandom(rarityTable);
  const chars = sets[type];

  let addressAsNumber = Math.floor(Number(address) / 1e30);
  // const divs = [1e19, 1e18];
  // const rndDivide = divs[Math.floor(Math.random() * divs.length)];

  addressAsNumber =
    addressAsNumber > 1e18 ? addressAsNumber - 1e18 : addressAsNumber;

  return { address, chars, color, seed: addressAsNumber / 1e18 };
}

export async function sha256(msg, algo) {
  const hashBuffer = await crypto.subtle.digest(
    algo || "SHA-256",
    typeof msg === "string" ? new TextEncoder().encode(msg) : msg,
  );

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex;
}

export async function genFakeAddress() {
  const sha = await sha256(
    Math.floor(Date.now() * performance.now() * Math.random()) +
      "" +
      crypto.randomUUID() +
      "-" +
      navigator.userAgent,
  );

  return `0x${sha.slice(0, 40)}`;
}

export async function getAddress(loc) {
  const url = new URL(loc);
  return url.searchParams.get("address") || (await genFakeAddress());
}

export async function dynamicImport(id) {
  return import(`https://api.ethscriptions.com/v2/ethscriptions/${id}/data`);
}

export async function loadMoira(el, addr, dims) {
  const _addr = addr || (await getAddress(window.location.href));
  // const isEther = _addr.startsWith("0x") && _addr.length === 42;
  // const addr = isEther ? _addr : `0x${await sha256(_addr)}`.slice(0, 42);

  const { address, chars, color, seed } = generateMoira(_addr);

  console.log({ _addr, address, chars, color, seed });

  const sketchId = `0x9e48663a8a451508c4968e85a45903727fcf81168ba745cf4d2f6ddb3e475b16`;
  const moiraId = `0x734dcf30eb1a5af5ab5dceb697aa21aa726ff76056e87d47e20dddc51831f52e`; // `0xdc2b2c61e95434f2c3008996febfc54de7ed0529f71bd3873186d6acb602f84e`;

  const { default: sketch } = await dynamicImport(sketchId);
  const { default: moira } = await dynamicImport(moiraId);

  const isMobileRegex =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|WPDesktop|IEMobile|Opera Mini/i;

  moira(sketch, chars, `${color}`, {
    seed: () => seed,

    padding: 0.03,

    importEthscription: dynamicImport,
    canvasOptions: {
      ...(navigator.userAgent.match(isMobileRegex)
        ? { dimensions: [1200, 1200] }
        : dims || { dimensions: [770, 770] }),

      // dimensions: [1200, 1200],
      // dimensions: [100, 100],
      // units: "in",
      // sasa
      // scaleToFitPaddingk: 1,
      // scaleToFitPadding: 2,
      scaleToView: true,
      scaleToFit: true,
      canvas: el || document.querySelector("#sketch"),
    },
  });
}
