export default async function handler(req, res) {
  const { query } = req.query;
  const apiKey = process.env.SERP_API_KEY;

  if (!query || !apiKey) {
    return res.status(400).json({ error: "Missing query or API key" });
  }

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch from SerpAPI" });
  }
}
