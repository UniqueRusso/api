// search.js (for Vercel API route)
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

async function fetchAndExtractReadableContent(urlToFetch) {
  console.log(`[Server] Attempting to fetch and extract content from: ${urlToFetch}`);
  try {
    // For sites like LinkedIn, direct fetching will likely get the public, non-logged-in version,
    // and might be heavily restricted or just a login page.
    // For other general websites, this has a better chance of success.
    const response = await fetch(urlToFetch, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        // 'Referer': 'https://www.google.com/' // Sometimes a referer can help
      },
      timeout: 8000 // 8 seconds timeout for fetching the page (Vercel Hobby plan has ~10s limit)
    });

    if (!response.ok) {
      console.error(`[Server] Failed to fetch ${urlToFetch}: ${response.status} ${response.statusText}`);
      return `Failed to fetch content (Status: ${response.status}).`; // Return status for LLM
    }

    const html = await response.text();
    const doc = new JSDOM(html, { url: urlToFetch });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    if (article && article.textContent) {
      const extracted = article.textContent.trim().substring(0, 4000) + (article.textContent.length > 4000 ? "..." : "");
      console.log(`[Server] Successfully extracted content snippet from ${urlToFetch} (length: ${extracted.length})`);
      return extracted;
    }
    console.log(`[Server] Readability could not parse meaningful content from ${urlToFetch}`);
    return "Readable content not found or page structure not suitable for extraction.";
  } catch (error) {
    console.error(`[Server] Error fetching or parsing ${urlToFetch}:`, error.message);
    return `Error during content extraction: ${error.name}.`;
  }
}

export default async function handler(req, res) {
  // ... (CORS headers, API key checks remain the same) ...
  const { query } = req.query;
  const apiKey = process.env.SERP_API_KEY;

  if (req.method === "OPTIONS") { return res.status(200).end(); }
  if (!query) { return res.status(400).json({ error: "Missing query parameter" }); }
  if (!apiKey) { /* ... */ return res.status(500).json({ error: "API key not configured." }); }

  const serpApiUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${apiKey}&num=5`; // Get top 5 results

  try {
    console.log(`[Server] Performing SerpAPI search for: "${query}"`);
    const serpResponse = await fetch(serpApiUrl);
    // ... (SerpAPI error handling) ...
    const serpData = await serpResponse.json();

    if (serpData.error) {
        console.error("[Server] SerpAPI returned an error:", serpData.error);
        return res.status(400).json({ error: "Search API error", details: serpData.error });
    }
    
    // Process up to 2 organic results for content extraction
    if (serpData.organic_results && serpData.organic_results.length > 0) {
      const resultsToProcess = serpData.organic_results.slice(0, 2); // Max 2 for performance

      for (let i = 0; i < resultsToProcess.length; i++) {
        const result = resultsToProcess[i];
        if (result.link) {
          // Skip LinkedIn for direct server-side fetch as it's usually just a login page or blocked
          // Unless you have a specific strategy for LinkedIn (e.g. a dedicated LinkedIn API if it existed for this use)
          if (result.link.toLowerCase().includes("linkedin.com/")) {
              console.log(`[Server] Skipping direct fetch for LinkedIn URL: ${result.link}`);
              serpData.organic_results[i].extracted_content_status = "Direct content extraction for LinkedIn profiles is generally not feasible due to login walls and restrictions. Please refer to the profile snippet if available, or ask the user for details.";
              serpData.organic_results[i].extracted_content = null; // Ensure it's null
          } else {
              const extractedContentOrStatus = await fetchAndExtractReadableContent(result.link);
              if (typeof extractedContentOrStatus === 'string' && 
                  (extractedContentOrStatus.startsWith("Failed to fetch") || 
                   extractedContentOrStatus.startsWith("Readable content not found") ||
                   extractedContentOrStatus.startsWith("Error during content extraction"))) {
                  serpData.organic_results[i].extracted_content_status = extractedContentOrStatus;
                  serpData.organic_results[i].extracted_content = null; // Ensure it's null
              } else if (extractedContentOrStatus) {
                  serpData.organic_results[i].extracted_content = extractedContentOrStatus;
                  serpData.organic_results[i].extracted_content_status = "Content extracted successfully.";
              } else { // Should be caught by the string checks above, but as a fallback
                  serpData.organic_results[i].extracted_content_status = "Content extraction did not yield results.";
                  serpData.organic_results[i].extracted_content = null;
              }
          }
        } else {
            serpData.organic_results[i].extracted_content_status = "No link provided in search result.";
            serpData.organic_results[i].extracted_content = null;
        }
      }
    }
    console.log("[Server] Sending processed search results to client.");
    res.status(200).json(serpData);

  } catch (error) {
    // ... (overall error handling) ...
  }
}
