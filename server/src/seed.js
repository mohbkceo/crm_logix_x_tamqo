import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

import { config } from "./config.js";
import { Wilaya } from "./models/index.js";

const WILAYAS = [
  ["01", "Adrar", 1200, 900],
  ["02", "Chlef", 850, 450],
  ["03", "Laghouat", 950, 550],
  ["04", "Oum El Bouaghi", 850, 450],
  ["05", "Batna", 900, 450],
  ["06", "Bejaia", 800, 450],
  ["07", "Biskra", 950, 550],
  ["08", "Bechar", 1000, 650],
  ["09", "Blida", 600, 400],
  ["10", "Bouira", 800, 450],
  ["11", "Tamanrasset", 1500, 1050],
  ["12", "Tebessa", 900, 450],
  ["13", "Tlemcen", 900, 500],
  ["14", "Tiaret", 850, 450],
  ["15", "Tizi Ouzou", 750, 450],
  ["16", "Alger", 400, 300],
  ["17", "Djelfa", 950, 550],
  ["18", "Jijel", 900, 450],
  ["19", "Setif", 800, 450],
  ["20", "Saida", 900, 500],
  ["21", "Skikda", 900, 450],
  ["22", "Sidi Bel Abbès", 900, 450],
  ["23", "Annaba", 850, 450],
  ["24", "Guelma", 900, 450],
  ["25", "Constantine", 800, 450],
  ["26", "Medea", 800, 450],
  ["27", "Mostaganem", 900, 450],
  ["28", "M'Sila", 850, 500],
  ["29", "Mascara", 900, 450],
  ["30", "Ouargla", 950, 600],
  ["31", "Oran", 800, 450],
  ["32", "El Bayadh", 1000, 600],
  ["33", "Illizi", 0, 0],
  ["34", "Bordj Bou Arreridj", 800, 450],
  ["35", "Boumerdes", 700, 450],
  ["36", "El Tarf", 850, 450],
  ["37", "Tindouf", 0, 0],
  ["38", "Tissemsilt", 900, 0],
  ["39", "El Oued", 950, 600],
  ["40", "Khenchela", 900, 0],
  ["41", "Souk Ahras", 900, 450],
  ["42", "Tipaza", 700, 450],
  ["43", "Mila", 900, 450],
  ["44", "Ain Defla", 900, 450],
  ["45", "Naama", 950, 600],
  ["46", "Ain Temouchent", 900, 450],
  ["47", "Ghardaia", 950, 550],
  ["48", "Relizane", 900, 450],
  ["49", "Timimoun", 1200, 0],
  ["50", "Bordj Badji Mokhtar", 0, 0],
  ["51", "Ouled Djellal", 950, 550],
  ["52", "Beni Abbès", 950, 0],
  ["53", "In Salah", 1500, 1100],
  ["54", "In Guezzam", 1500, 0],
  ["55", "Touggourt", 950, 600],
  ["56", "Djanet", 0, 0],
  ["57", "M'Ghair", 950, 0],
  ["58", "Meniaa", 950, 700],
];

export async function seed() {
  await Wilaya.bulkWrite(
    WILAYAS.map(([agencyId, name, homeShippingPrice, deskShippingPrice]) => ({
      updateOne: {
        filter: { agencyId },
        update: {
          $set: {
            agencyId,
            name,
            homeShippingPrice,
            deskShippingPrice,

            // Disable only wilayas where ABExpress has
            // neither Home nor Stopdesk delivery.
            active: homeShippingPrice > 0 || deskShippingPrice > 0,
          },
        },
        upsert: true,
      },
    })),
  );

  console.log(`Seeded ${WILAYAS.length} Wilaya shipping prices.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!config.mongoUri) {
    throw new Error("Set MONGODB_URI before seeding.");
  }

  await mongoose.connect(config.mongoUri);

  try {
    await seed();
  } finally {
    await mongoose.disconnect();
  }
}
