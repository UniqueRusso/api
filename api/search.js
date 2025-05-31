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
      console.log(`[Server Backend] Extracted content from ${urlToFetch} (Title: ${pageTitle}, Length: ${truncatedContent.length})`);
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

  const apiKey = process.env.SERP_API_KEY;

  try {
    if (queryOrUrl.toLowerCase().startsWith("url:")) {
      const actualUrl = queryOrUrl.substring(4);
      console.log(`[Server Backend] Direct URL fetch requested for: "${actualUrl}"`);
      if (!actualUrl || !actualUrl.toLowerCase().startsWith("http")) {
        return res.status(400).json({ error: "Invalid URL for direct fetching." });
      }
      
      const extractionResult = await fetchAndExtractReadableContent(actualUrl);
      
      return res.status(200).json({
        source_url: actualUrl,
        title: extractionResult.title,
        snippet: extractionResult.content ? (extractionResult.content.substring(0, 250) + (extractionResult.content.length > 250 ? "..." : "")) : "N/A",
        extracted_content: extractionResult.content,
        extracted_content_status: extractionResult.status
      });

    } else { 
      if (!apiKey) {
        console.error("[Server Backend] SERP_API_KEY missing for SerpAPI search.");
        return res.status(500).json({ error: "Search API key not configured." });
      }
      const serpApiUrl = `https://api.search.brave.com/res/v1/web/search.json?q=${encodeURIComponent(queryOrUrl)}&api_key=${apiKey}&num=5`; // num=5 to get a few results
      console.log(`[Server Backend] SerpAPI search for: "${queryOrUrl}"`);
      const serpResponse = await fetch(serpApiUrl);

      if (!serpResponse.ok) {
        const errBody = await serpResponse.text().catch(()=>"SerpAPI error body unreadable");
        console.error("[Server Backend] SerpAPI Error:", serpResponse.status, errBody);
        return res.status(serpResponse.status).json({ error: `SerpAPI fetch error: ${serpResponse.statusText}`, details: errBody });
      }
      const serpData = await serpResponse.json();
      if (serpData.error) {
        console.error("[Server Backend] SerpAPI app error:", serpData.error);
        return res.status(400).json({ error: "SerpAPI application error", details: serpData.error });
      }

      if (serpData.organic_results && serpData.organic_results.length > 0) {
        const resultsToProcessLimit = 2; // Limit to avoid timeouts
        const resultsToProcess = serpData.organic_results.slice(0, resultsToProcessLimit);
        
        const processedResultsPromises = resultsToProcess.map(async (result) => {
          const newResult = { ...result, extracted_content: null, extracted_content_status: "Processing not attempted yet." }; // Default status
          if (newResult.link) {
            // IT WILL NOW ATTEMPT TO FETCH ALL LINKS, INCLUDING LINKEDIN
            const extraction = await fetchAndExtractReadableContent(newResult.link);
            newResult.extracted_content = extraction.content;
            newResult.extracted_content_status = extraction.status;
            // Optionally update the title from the fetched page if Readability found a better one
            // if (extraction.title && extraction.title !== "N/A") {
            //   newResult.title = extraction.title;
            // }
          } else {
            newResult.extracted_content_status = "No link provided in search result.";
          }
          return newResult;
        });
        
        const processedResults = await Promise.all(processedResultsPromises);
        // Replace the original slice of results with the processed ones
        serpData.organic_results.splice(0, resultsToProcessLimit, ...processedResults);
      }
      console.log("[Server Backend] Sending processed SerpAPI results.");
      return res.status(200).json(serpData);
    }
  } catch (error) {
    console.error("[Server Backend] Overall handler error:", error.name, error.message, error.stack);
    return res.status(500).json({ error: "Internal server error processing request.", details: error.message });
  }
}
