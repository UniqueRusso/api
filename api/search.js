// search.js (for Vercel API route /api/search.js)

// Using require for node-fetch in a CommonJS Vercel environment
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// Helper function to fetch and parse content from a URL
async function fetchAndExtractReadableContent(urlToFetch) {
  console.log(`[Server Backend] Attempting to fetch and extract content from: ${urlToFetch}`);
  try {
    const response = await fetch(urlToFetch, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 8000 // 8 seconds timeout (Vercel Hobby plan has ~10s total execution limit)
    });

    if (!response.ok) {
      console.error(`[Server Backend] Failed to fetch ${urlToFetch}: ${response.status} ${response.statusText}`);
      // Return a clear status message for the LLM
      return { status: `Failed to fetch content (Status: ${response.status}).`, content: null };
    }

    const html = await response.text();
    const doc = new JSDOM(html, { url: urlToFetch }); // Providing URL helps Readability resolve relative links if needed
    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    if (article && article.textContent) {
      const extractedText = article.textContent.trim();
      // Truncate to a reasonable length for the LLM context
      const truncatedContent = extractedText.substring(0, 4000) + (extractedText.length > 4000 ? "..." : "");
      console.log(`[Server Backend] Successfully extracted content snippet from ${urlToFetch} (original length: ${extractedText.length}, truncated: ${truncatedContent.length})`);
      return { status: "Content extracted successfully.", content: truncatedContent };
    }

    console.log(`[Server Backend] Readability could not parse meaningful content from ${urlToFetch}`);
    return { status: "Readable content not found or page structure not suitable for extraction.", content: null };

  } catch (error) {
    console.error(`[Server Backend] Error during fetch or parsing for ${urlToFetch}:`, error.name, error.message);
    // Return a clear error status for the LLM
    return { status: `Error during content extraction: ${error.name}.`, content: null };
  }
}

export default async function handler(req, res) {
  // Standard CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*"); // Adjust if you want to restrict to your specific domain
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { query } = req.query;
  const apiKey = process.env.SERP_API_KEY; // Ensure this is set in Vercel environment variables

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter" });
  }
  if (!apiKey) {
    console.error("[Server Backend] SERP_API_KEY is not set in environment variables.");
    return res.status(500).json({ error: "Search service API key is not configured on the server." });
  }

  // Construct SerpAPI URL - fetch a few results to choose from
  const serpApiUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${apiKey}&num=5`;

  try {
    console.log(`[Server Backend] Performing SerpAPI search for: "${query}"`);
    const serpResponse = await fetch(serpApiUrl);

    if (!serpResponse.ok) {
        const errorBody = await serpResponse.text().catch(() => "Could not read SerpAPI error response.");
        console.error("[Server Backend] SerpAPI Error:", serpResponse.status, errorBody);
        return res.status(serpResponse.status).json({ 
            error: `Failed to fetch from Search API (SerpAPI): ${serpResponse.statusText}`, 
            details: errorBody 
        });
    }
    
    const serpData = await serpResponse.json();

    if (serpData.error) {
        console.error("[Server Backend] SerpAPI returned an application-level error:", serpData.error);
        return res.status(400).json({ error: "Search API application error", details: serpData.error });
    }
    
    // Enhance organic results with extracted content
    if (serpData.organic_results && serpData.organic_results.length > 0) {
      // Process a limited number of results to stay within execution limits
      const resultsToProcessLimit = 2; 
      const resultsToProcess = serpData.organic_results.slice(0, resultsToProcessLimit);

      // Use Promise.all to fetch and process content for multiple links concurrently (up to the limit)
      const processedResultsPromises = resultsToProcess.map(async (result, index) => {
        const newResult = { ...result }; // Create a copy to modify

        if (newResult.link) {
          if (newResult.link.toLowerCase().includes("linkedin.com/")) {
            console.log(`[Server Backend] Skipping direct content fetch for LinkedIn URL: ${newResult.link}`);
            newResult.extracted_content_status = "Direct content extraction for LinkedIn profiles is generally not feasible due to login walls and site restrictions. Rely on snippets or ask the user for details.";
            newResult.extracted_content = null;
          } else {
            const extractionResult = await fetchAndExtractReadableContent(newResult.link);
            newResult.extracted_content_status = extractionResult.status;
            newResult.extracted_content = extractionResult.content;
          }
        } else {
          newResult.extracted_content_status = "No link provided in search result.";
          newResult.extracted_content = null;
        }
        return newResult;
      });

      // Replace the original slice of results with the processed ones
      const processedResults = await Promise.all(processedResultsPromises);
      serpData.organic_results.splice(0, resultsToProcessLimit, ...processedResults);
    }

    console.log("[Server Backend] Sending processed search results to client.");
    res.status(200).json(serpData);

  } catch (error) {
    console.error("[Server Backend] Overall error in search handler:", error.name, error.message, error.stack);
    res.status(500).json({ 
        error: "Failed to process search request due to an internal server error.", 
        details: error.message // Send a generic message to client, log details on server
    });
  }
}
