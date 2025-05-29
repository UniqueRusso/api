// search.js (for Vercel API route)

// Use dynamic import for node-fetch if you're in an ES module environment
// or stick to require if your Vercel function is CommonJS.
// For Vercel serverless functions, you can typically use require.
const fetch = require('node-fetch'); // For fetching HTML content of pages
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// Helper function to fetch and parse content from a URL
async function fetchAndExtractReadableContent(urlToFetch) {
  try {
    const response = await fetch(urlToFetch, {
      headers: {
        // A common user agent can sometimes help avoid simple blocks
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000 // 10 seconds timeout for fetching the page
    });

    if (!response.ok) {
      console.error(`Failed to fetch ${urlToFetch}: ${response.statusText}`);
      return null;
    }

    const html = await response.text();
    const doc = new JSDOM(html, { url: urlToFetch }); // Provide URL for Readability
    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    if (article && article.textContent) {
      // Return a snippet of the text content (e.g., first 3000-5000 characters)
      // to keep the payload to the LLM manageable.
      return article.textContent.trim().substring(0, 4000) + (article.textContent.length > 4000 ? "..." : "");
    }
    return null;
  } catch (error) {
    console.error(`Error fetching or parsing ${urlToFetch}:`, error);
    return null;
  }
}

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); // Added Authorization for future

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { query } = req.query;
  const apiKey = process.env.SERP_API_KEY;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter" });
  }
  if (!apiKey) {
    console.error("SERP_API_KEY is not set in environment variables.");
    return res.status(500).json({ error: "API key for search service is not configured on the server." });
  }

  const serpApiUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${apiKey}`;

  try {
    const serpResponse = await fetch(serpApiUrl);
    if (!serpResponse.ok) {
        const errorBody = await serpResponse.text();
        console.error("SerpAPI Error:", serpResponse.status, errorBody);
        return res.status(serpResponse.status).json({ error: `Failed to fetch from SerpAPI: ${serpResponse.statusText}`, details: errorBody });
    }
    const serpData = await serpResponse.json();

    // Now, try to fetch content for the top organic result (if any)
    if (serpData.organic_results && serpData.organic_results.length > 0) {
      const topResult = serpData.organic_results[0];
      if (topResult.link) {
        console.log(`Fetching content for top result: ${topResult.link}`);
        const extractedContent = await fetchAndExtractReadableContent(topResult.link);
        if (extractedContent) {
          // Add the extracted content to the result object
          // You might want to add it to each result you process, or create a new top-level field.
          // For simplicity, let's add it to the top result itself.
          serpData.organic_results[0].extracted_content = extractedContent;
        } else {
          serpData.organic_results[0].extracted_content_status = "Failed to retrieve or parse content.";
        }
      }

      // Optionally, fetch for the second result too (be mindful of execution time)
      // if (serpData.organic_results.length > 1) {
      //   const secondResult = serpData.organic_results[1];
      //   if (secondResult.link) {
      //     console.log(`Fetching content for second result: ${secondResult.link}`);
      //     const extractedContentSecond = await fetchAndExtractReadableContent(secondResult.link);
      //     if (extractedContentSecond) {
      //       serpData.organic_results[1].extracted_content = extractedContentSecond;
      //     }
      //   }
      // }
    }

    res.status(200).json(serpData);

  } catch (error) {
    console.error("Overall error in search handler:", error);
    res.status(500).json({ error: "Failed to process search request.", details: error.message });
  }
}
