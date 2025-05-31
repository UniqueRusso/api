// search.js (Vercel API Route: api/search.js)

const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

async function fetchAndExtractReadableContent(urlToFetch) {
  console.log(`[Server Backend] Attempting to fetch and extract content from: ${urlToFetch}`);
  let pageTitle = "N/A";

  try {
    const response = await fetch(urlToFetch, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 8000
    });

    if (!response.ok) {
      console.error(`[Server Backend] Failed to fetch ${urlToFetch}: ${response.status} ${response.statusText}`);
      return { status: `Failed to fetch content (Status: ${response.status}). It might be protected, private, or a login page.`, content: null, title: pageTitle };
    }

    const html = await response.text();
    const doc = new JSDOM(html, { url: urlToFetch });
    pageTitle = doc.window.document.title || "N/A";

    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    if (article && article.textContent) {
      const extractedText = article.textContent.trim();
      const truncatedContent = extractedText.substring(0, 4000) + (extractedText.length > 4000 ? "..." : "");
      console.log(`[Server Backend] Extracted content from ${urlToFetch} (Title: ${article.title || pageTitle}, Length: ${truncatedContent.length})`);
      return { status: "Content extracted successfully.", content: truncatedContent, title: article.title || pageTitle };
    }

    console.log(`[Server Backend] Readability could not parse meaningful content from ${urlToFetch} (Title: ${pageTitle}). Page might be JavaScript-heavy, an application, or not article-like.`);
    return { status: "Readable content not found or page structure not suitable for extraction.", content: null, title: pageTitle };

  } catch (error) {
    console.error(`[Server Backend] Error during fetch/parsing for ${urlToFetch}:`, error.name, error.message);
    return { status: `Error during content extraction: ${error.name}. The site might be blocking automated access.`, content: null, title: pageTitle };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { return res.status(200).end(); }
  if (req.method !== "GET") { return res.status(405).json({ error: "Method Not Allowed" }); }

  let queryOrUrl = req.query.query;
  if (!queryOrUrl) { return res.status(400).json({ error: "Missing query parameter" }); }

  // This part remains for direct URL fetching if client sends "url:http://example.com"
  if (queryOrUrl.toLowerCase().startsWith("url:")) {
    const actualUrl = queryOrUrl.substring(4);
    console.log(`[Server Backend] Direct URL fetch requested for: "${actualUrl}"`);
    if (!actualUrl || !actualUrl.toLowerCase().startsWith("http")) {
      return res.status(400).json({ error: "Invalid URL for direct fetching." });
    }
    
    const extractionResult = await fetchAndExtractReadableContent(actualUrl);
    
    // Note: The client-side (zombie.js) currently turns all URL fetches into "site:" queries
    // which go to the `else` block below. This "url:" path in the backend might be
    // for a different direct access pattern or legacy use.
    return res.status(200).json({
      // This structure is different from organic_results, client needs to handle accordingly if using this path.
      source_url: actualUrl,
      title: extractionResult.title,
      snippet: extractionResult.content ? (extractionResult.content.substring(0, 250) + (extractionResult.content.length > 250 ? "..." : "")) : "N/A",
      extracted_content: extractionResult.content,
      extracted_content_status: extractionResult.status
    });

  } else {
    // This block handles general web searches and "site:" queries using Brave Search API
    const braveApiKey = process.env.BRAVE_API_KEY; // Use your Brave Search API Key env variable
    if (!braveApiKey) {
      console.error("[Server Backend] BRAVE_API_KEY environment variable missing.");
      return res.status(500).json({ error: "Search API key not configured on the server." });
    }

    // Fetch top 3 results from Brave to have some buffer, will process up to 2.
    const braveApiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(queryOrUrl)}&count=3`;
    console.log(`[Server Backend] Brave Search API request for: "${queryOrUrl}" to URL: ${braveApiUrl}`);

    let braveData;
    try {
      const braveResponse = await fetch(braveApiUrl, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': braveApiKey,
          'User-Agent': 'AI Assistant Backend Fetcher/1.0' // Good practice to set a User-Agent
        }
      });

      if (!braveResponse.ok) {
        const errBody = await braveResponse.text().catch(() => "Brave API error body unreadable");
        console.error(`[Server Backend] Brave Search API Error: ${braveResponse.status} ${braveResponse.statusText}. Body: ${errBody}`);
        // Try to parse errBody if it's JSON, otherwise return as text
        let errorDetails = errBody;
        try { errorDetails = JSON.parse(errBody); } catch (e) { /* ignore parsing error */ }
        return res.status(braveResponse.status).json({ error: `Brave API fetch error: ${braveResponse.statusText}`, details: errorDetails });
      }
      braveData = await braveResponse.json();

    } catch (fetchError) {
      console.error("[Server Backend] Network or fetch error calling Brave Search API:", fetchError);
      return res.status(500).json({ error: "Network error while contacting Brave Search API.", details: fetchError.message });
    }
    
    // Check for application-level errors returned in Brave's JSON response
    // This depends on Brave's specific error response structure. Common patterns include an 'error' or 'errors' key.
    // For Brave, a 200 OK with an empty `web.results` is not an error, but simply no results.
    // Actual errors are usually non-200 statuses, handled above. If Brave has specific JSON error objects on 200 OK, add checks here.

    let processedOrganicResults = [];
    if (braveData.web && braveData.web.results && braveData.web.results.length > 0) {
      const resultsToProcessLimit = 2; // Process the top 2 results for content extraction
      const resultsFromBrave = braveData.web.results.slice(0, resultsToProcessLimit);
      
      const processedResultsPromises = resultsFromBrave.map(async (braveResult) => {
        const mappedResult = {
          title: braveResult.title || "N/A",
          link: braveResult.url, // Brave uses 'url'
          snippet: braveResult.description || braveResult.meta_url?.path || "N/A", // Brave uses 'description'
          // additional potentially useful fields from Brave:
          // page_age: braveResult.page_age,
          // profile: braveResult.profile, // if available
          extracted_content: null,
          extracted_content_status: "Processing not attempted yet."
        };

        if (mappedResult.link) {
          const extraction = await fetchAndExtractReadableContent(mappedResult.link);
          mappedResult.extracted_content = extraction.content;
          mappedResult.extracted_content_status = extraction.status;
          // Update title from extracted content if it's more specific or different and valid
          if (extraction.title && extraction.title !== "N/A" && extraction.title !== mappedResult.title) {
            mappedResult.title = extraction.title;
          }
        } else {
          mappedResult.extracted_content_status = "No link provided in Brave search result.";
        }
        return mappedResult;
      });
      
      processedOrganicResults = await Promise.all(processedResultsPromises);
    } else {
      console.log(`[Server Backend] No web results found by Brave Search API for query: "${queryOrUrl}"`);
    }
    
    console.log(`[Server Backend] Sending ${processedOrganicResults.length} processed Brave API results to client.`);
    // Return data in the format expected by zombie.js (with an "organic_results" key)
    return res.status(200).json({ 
        organic_results: processedOrganicResults,
        // Optionally, include other Brave data if useful for the client, e.g., query summary
        // search_provider_query: braveData.query?.original, 
    });
  }
}
