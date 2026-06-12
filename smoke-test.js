const fs = require('fs');
const path = require('path');
const axios = require('axios');

const API_URL = 'http://localhost:3000/scraping/upload';
const HTML_DIR = path.join(__dirname, 'src/utils/html');

// Mapeo de nombres de equipo (según el archivo) a fbrefId
// Estos IDs están tomados de tu archivo src/utils/wc2026-groups.ts
const teamToFbrefId = {
  'Mexico': 'b009a548',
  'South Africa': '506f1741',
  'Korea Republic': '473f0fbf',
  'Czechia': '2740937c',
  'Canada': '9c6d90a0',
  'Bosnia and Herzegovina': '6c5ef1c3',
  'Qatar': '9b696ed1',
  'Switzerland': '81021a70',
  'Brazil': '304635c3',
  'Morocco': 'af41ccda',
  'Haiti': '61828292',
  'Scotland': '602d3994',
  'United States': '0f66725b',
  'Paraguay': 'd2043442',
  'Australia': 'b90bf4f9',
  'Turkiye': 'ac6bcf92',        // nota: en archivo aparece "Türkiye"
  'Germany': 'c1e40422',
  'Curacao': 'e0f5893a',
  "Côte d'Ivoire": '24772b12',   // nota: acento y apóstrofe
  'Ecuador': '123acaf8',
  'Netherlands': '5bb5024a',
  'Japan': 'ffcf1690',
  'Sweden': '296f69e7',
  'Tunisia': 'a7c7562a',
  'Belgium': '361422b9',
  'Egypt': 'b8889750',
  'IR Iran': '6a08f71e',
  'New Zealand': '259855f0',
  'Spain': 'b561dd30',
  'Cape Verde': '31fa6fa6',
  'Saudi Arabia': '6e84edac',
  'Uruguay': '870e020f',
  'France': 'b1b36dcd',
  'Senegal': '9ab5c684',
  'Iraq': 'ec843efd',
  'Norway': '599eba19',
  'Argentina': 'f9fddd6e',
  'Algeria': '1e2dba57',
  'Austria': 'd5121f10',
  'Jordan': '3e22f0fa',
  'Portugal': '4a1b4ea8',
  'Congo DR': '9be9f315',
  'Uzbekistan': 'cd389e75',
  'Colombia': 'ab73cfe5',
  'England': '1862c019',
  'Croatia': '7b08e376',
  'Ghana': '9349828d',
  'Panama': '6061a82d',
};

// Función para extraer el nombre del equipo del nombre del archivo
function extractTeamName(filename) {
  // El patrón es: "Algeria Men Stats, WCQ — CAF (M) _ FBref.com.html"
  // Quitamos todo después de "Men Stats" o "Women Stats"
  let name = filename.replace(/\s+Men\s+Stats.*$/, '')
                     .replace(/\s+Women\s+Stats.*$/, '')
                     .trim();
  // Casos especiales
  if (name === "Korea Republic") return "Korea Republic";
  if (name === "Côte d'Ivoire") return "Côte d'Ivoire";
  if (name === "United States") return "United States";
  if (name === "IR Iran") return "IR Iran";
  if (name === "Congo DR") return "Congo DR";
  if (name === "Türkiye") return "Turkiye";   // ajuste a Turkiye sin diéresis
  if (name === "Czech Republic") return "Czechia"; // a veces puede venir como Czech Republic
  if (name === "Curaçao") return "Curacao";
  return name;
}

async function uploadAll() {
  const files = fs.readdirSync(HTML_DIR).filter(f => f.endsWith('.html'));
  console.log(`📁 Encontrados ${files.length} archivos HTML.`);

  let successCount = 0;
  let failCount = 0;
  const errors = [];

  for (const file of files) {
    const teamName = extractTeamName(file);
    const fbrefId = teamToFbrefId[teamName];
    
    if (!fbrefId) {
      console.log(`❌ Saltando ${file}: no se encontró fbrefId para "${teamName}"`);
      failCount++;
      continue;
    }

    const htmlPath = path.join(HTML_DIR, file);
    const html = fs.readFileSync(htmlPath, 'utf8');
    
    try {
      const response = await axios.post(API_URL, { fbrefId, html });
      console.log(`✅ ${teamName} (${fbrefId}): ${response.data.playersFound} jugadores, ${response.data.matchesFound} partidos`);
      successCount++;
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      console.log(`❌ ${teamName}: ${msg}`);
      errors.push({ team: teamName, error: msg });
      failCount++;
    }
    
    // Pequeña pausa para no saturar el servidor
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`\n📊 Resumen: ${successCount} exitosos, ${failCount} fallidos.`);
  if (errors.length) {
    console.log('Errores:', errors);
  }
}

uploadAll().catch(console.error);