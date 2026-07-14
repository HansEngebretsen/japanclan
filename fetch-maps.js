const fs = require('fs');
const https = require('https');
const path = require('path');

const API_KEY = fs.readFileSync('key.env', 'utf8').trim();

const locations = [
  { wp: "Narita International Airport", z: 4 },
  { wp: "all day place shibuya", z: 8 },
  { wp: "Meiji Jingu Stadium", z: 8 },
  { wp: "Tokyo DisneySea", z: 8 },
  { wp: "Shin-Hakodate-Hokuto Station", z: 5 },
  { wp: "Sapporo Station", z: 5 },
  { wp: "Premier Hotel Cabin President Hakodate", z: 8 },
  { wp: "Onsen Ryokan Yuen Sapporo", z: 8 },
  { wp: "Otaru Kourakuen", z: 8 },
  { wp: "Haneda Airport", z: 4 },
  { wp: "Bellustar Tokyo, a Pan Pacific Hotel", z: 8 },
  // mock-data waypoints (dev setting ?mock=1) — MOCK_ITIN in index.html
  { wp: "Tokyo Dome", z: 8 },
  { wp: "Tokyo Disneyland", z: 8 }
];

const dir = path.join(__dirname, 'maps');
if (!fs.existsSync(dir)){
    fs.mkdirSync(dir);
}

locations.forEach(loc => {
  const filename = loc.wp + '.png';
  const filepath = path.join(dir, filename);
  
  // High-res retina 140x140 image (which we will crop to 60x60 in CSS to hide the logo)
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(loc.wp)}&zoom=${loc.z}&size=140x140&scale=2&maptype=roadmap&style=feature:all|element:labels|visibility:off&key=${API_KEY}`;

  https.get(url, (res) => {
    if (res.statusCode === 200) {
      const file = fs.createWriteStream(filepath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`Saved ${filename}`);
      });
    } else {
      console.error(`Failed to fetch ${loc.wp}: ${res.statusCode}`);
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => { console.error(rawData); });
    }
  }).on('error', (err) => {
    console.error(`Error fetching ${loc.wp}: `, err.message);
  });
});
