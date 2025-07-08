document.addEventListener('DOMContentLoaded', () => {
  // Helper function to safely get elements
  const getElement = (id) => document.getElementById(id) || null;

  // Get all required elements
  const elements = {
    summarizeBtn: getElement('summarize-btn'),
    summarizeLoading: getElement('summarize-loading'),
    formatSelect: getElement('format-select'),
    outputDiv: getElement('output'),
    quotaStatus: getElement('quota-status'),
    saveBtn: getElement('save-btn'),
    progressContainer: getElement('progress-container'),
    extractionProgress: getElement('extraction-progress'),
    contentLength: getElement('content-length'),
    copyBtn: getElement('copy-btn'),
    exportSelect: getElement('export-select'),
    exportOkBtn: getElement('export-ok-btn')
  };

  // State management
  let apiKey = '';
  let isProcessing = false;
  let selectedExportFormat = '';

  function formatOutput(content, format) {
    switch(format) {
      case 'bullets':
        return `<ul>${content}</ul>`;
      case 'tweet':
        const tweetHashtags = '#summary #insight #knowledge';
        return `<div class="tweet-style">${content}<br><br>${tweetHashtags} 🚀</div>`;
      case 'linkedin':
        const intro = `Excited to share key insights from my recent read! 📚 Here's a concise summary to spark discussion and inspire growth.`;
        const linkedinHashtags = '#ProfessionalDevelopment #CareerGrowth #IndustryInsights #Leadership';
        return `
          <div class="linkedin-style">
            <p>${intro}</p>
            <ul>${content}</ul>
            <p>💡 What are your thoughts on these insights? Let's discuss in the comments below! ${linkedinHashtags}</p>
          </div>`;
      default:
        return content;
    }
  }

  // Initialize from storage
  chrome.storage.sync.get(['apiKey', 'clips'], (result) => {
    if (result.apiKey) {
      apiKey = result.apiKey;
    }
    if (!result.clips) {
      chrome.storage.sync.set({ clips: [] });
    }
  });

  // Helper functions
  function showLoading(show) {
    if (elements.summarizeLoading) {
      elements.summarizeLoading.style.display = show ? 'inline-block' : 'none';
    }
    if (elements.summarizeBtn) {
      elements.summarizeBtn.disabled = show;
    }
  }

  function showProgress(show, percent = 0) {
    if (elements.progressContainer) {
      elements.progressContainer.style.display = show ? 'block' : 'none';
    }
    if (elements.extractionProgress) {
      elements.extractionProgress.style.width = `${percent}%`;
    }
  }

  function showError(message) {
    if (elements.outputDiv) {
      elements.outputDiv.textContent = `Error: ${message}`;
      elements.outputDiv.style.color = '#dc2626';
      elements.outputDiv.style.border = '1px solid #fecaca';
    }
  }

  function clearError() {
    if (elements.outputDiv) {
      elements.outputDiv.style.color = '';
      elements.outputDiv.style.border = '';
    }
  }

  function updateContentLength(length) {
    if (elements.contentLength) {
      elements.contentLength.textContent = `Processing ${length.toLocaleString()} characters...`;
    }
  }

  function buildPrompt(text, format) {
    const textLength = text.length;
    const isLongContent = textLength > 10000;
    
    const prompts = {
      bullets: isLongContent 
        ? `Analyze this comprehensive content and provide 7-10 key bullet points covering all main topics:\n${text}`
        : `Summarize these key points in concise bullet points:\n${text}`,
      paragraph: isLongContent
        ? `Write a detailed executive summary (400-600 words) capturing all essential information from this comprehensive document. Include key findings, conclusions, and recommendations:\n${text}`
        : `Write a concise summary (100-200 words):\n${text}`,
      tweet: `Distill the core message into one insightful tweet (280 characters max). Capture the essence while being engaging:\n${text.substring(0, 1000)}`,
      linkedin: isLongContent
        ? `Create a professional LinkedIn post summary with 5-7 concise bullet points highlighting key insights, designed to engage a professional audience:\n${text}`
        : `Summarize in 5-7 concise bullet points for a professional LinkedIn post:\n${text}`
    };
  
    return prompts[format] || prompts.bullets;
  }

  async function getAISummary(prompt) {
    if (!apiKey) throw new Error('Please enter your OpenRouter API key in settings');

    try {
      const response = await fetch(CONFIG.API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': chrome.runtime.getURL('popup.html'),
          'X-Title': 'Web Summarizer Extension'
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          model: CONFIG.DEFAULT_MODEL,
          max_tokens: CONFIG.MAX_TOKENS
        })
      });

      if (response.status === 401) throw new Error('Invalid API key');
      if (response.status === 429) {
        const resetTime = parseInt(response.headers.get('x-ratelimit-reset')) || 30;
        throw new Error(`Rate limited. Please wait ${resetTime} seconds.`);
      }
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'API request failed');
      }

      const data = await response.json();
      let content = data.choices?.[0]?.message?.content || 'No response generated';
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '');
      content = content.replace(/^\* (.*?)$/gm, '<li>$1</li>');
      
      return {
        summary: content,
        quota: {
          remaining: response.headers.get('x-ratelimit-remaining'),
          reset: response.headers.get('x-ratelimit-reset')
        }
      };
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  }

  async function extractFullContent(tabId) {
    return new Promise((resolve) => {
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try {
            const selection = window.getSelection().toString().trim();
            if (selection.length > 0) {
              return selection;
            }
  
            if (window.PDFViewerApplication || document.querySelector('embed[type="application/pdf"]')) {
              if (window.PDFViewerApplication?.pdfDocument) {
                return Array.from(document.querySelectorAll('.textLayer div')).map(el => el.textContent).join(' ');
              }
              return 'PDF content detected but extraction failed. Try downloading and opening in browser.';
            }
  
            if (window.location.host.includes('docs.google.com')) {
              if (window.location.pathname.includes('/spreadsheets/')) {
                return Array.from(document.querySelectorAll('.kix-lineview-content'))
                  .map(el => el.textContent.trim())
                  .filter(Boolean)
                  .join('\n');
              }
              if (window.location.pathname.includes('/document/')) {
                return Array.from(document.querySelectorAll('.kix-paragraphrenderer'))
                  .map(el => el.textContent.trim())
                  .filter(Boolean)
                  .join('\n');
              }
            }
  
            const siteHandlers = {
              'twitter.com': () => Array.from(document.querySelectorAll('[data-testid="tweetText"]')).map(t => t.textContent).join('\n\n'),
              'reddit.com': () => Array.from(document.querySelectorAll('[data-adclicklocation="title"],[data-test-id="post-content"]')).map(p => p.textContent).join('\n\n'),
              'wikipedia.org': () => document.querySelector('#bodyContent')?.textContent || document.body.textContent,
              'medium.com': () => document.querySelector('article')?.textContent || document.body.textContent
            };
  
            for (const [domain, handler] of Object.entries(siteHandlers)) {
              if (window.location.host.includes(domain)) {
                return handler();
              }
            }
  
            const mainContent = document.querySelector('article, main, .post-content, .content, #content') || 
                              document.body;
            
            const unwanted = mainContent.querySelectorAll('nav, footer, script, style, iframe, noscript, button, form');
            unwanted.forEach(el => el.remove());
            
            let text = mainContent.innerText
              .replace(/[\n\r]+/g, '\n')
              .replace(/\s+/g, ' ')
              .trim();
  
            return text.substring(0, 50000);
          } catch (e) {
            console.error('Content extraction error:', e);
            return '';
          }
        }
      }, (results) => {
        const content = results?.[0]?.result || '';
        resolve(content);
      });
    });
  }
  
  async function handleSummarize() {
    if (isProcessing) return;
    isProcessing = true;
    showLoading(true);
    showProgress(true, 0);
    if (elements.outputDiv) elements.outputDiv.textContent = 'Starting extraction...';
    clearError();
  
    try {
      if (!apiKey) throw new Error('Please enter your OpenRouter API key first');
  
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found');
  
      if (elements.outputDiv) elements.outputDiv.textContent = 'Extracting content...';
      showProgress(true, 30);
      
      const text = await extractFullContent(tab.id);
      if (!text) throw new Error('No text found. Please try a different page.');
  
      updateContentLength(text.length);
      showProgress(true, 70);
      if (elements.outputDiv) {
        elements.outputDiv.textContent = text.length > 1000 
          ? `Extracted ${text.length.toLocaleString()} characters (selection detected). Processing...`
          : `Extracted selected text. Processing...`;
      }
  
      const format = elements.formatSelect ? elements.formatSelect.value : 'bullets';
      const prompt = buildPrompt(text, format);
      
      showProgress(true, 90);
      const response = await getAISummary(prompt);
  
      if (elements.outputDiv) elements.outputDiv.innerHTML = formatOutput(response.summary, format);
      updateQuotaStatus(response.quota);
      showProgress(false);
  
    } catch (error) {
      console.error('Summarization failed:', error);
      showError(error.message);
    } finally {
      isProcessing = false;
      showLoading(false);
      showProgress(false);
    }
  }

  // Export functions
  function exportToPDF() {
    if (!elements.outputDiv || !elements.outputDiv.textContent) return;
    if (typeof html2pdf === 'undefined') {
      showError('PDF export library not loaded.');
      return;
    }
    const element = elements.outputDiv;
    html2pdf().from(element).save('ClipGenie_Summary.pdf');
  }
  
  function exportToWord() {
    if (!elements.outputDiv || !elements.outputDiv.textContent) return;
    if (typeof saveAs === 'undefined') {
      showError('Word export library not loaded.');
      return;
    }
    const content = elements.outputDiv.textContent;
    const blob = new Blob(['\ufeff', content], { type: 'application/msword' });
    saveAs(blob, 'ClipGenie_Summary.doc');
  }

  // Event listeners
  if (elements.summarizeBtn) {
    elements.summarizeBtn.addEventListener('click', handleSummarize);
  }
  
  if (elements.saveBtn) {
    elements.saveBtn.addEventListener('click', () => {
      if (!elements.outputDiv || !elements.outputDiv.textContent) return;
      
      chrome.storage.sync.get(['clips'], (result) => {
        const clips = result.clips || [];
        clips.push({
          text: elements.outputDiv.textContent,
          timestamp: new Date().toISOString()
        });
        chrome.storage.sync.set({ clips }, () => {
          if (elements.outputDiv) {
            elements.outputDiv.textContent += '\n\n✅ Saved to clips!';
          }
        });
      });
    });
  }

  if (elements.copyBtn) {
    elements.copyBtn.addEventListener('click', () => {
      if (!elements.outputDiv || !elements.outputDiv.textContent) return;
      
      const textToCopy = elements.outputDiv.textContent;
      navigator.clipboard.writeText(textToCopy).then(() => {
        elements.copyBtn.textContent = '✅';
        setTimeout(() => {
          elements.copyBtn.textContent = '📋';
        }, 2000);
      }).catch(err => {
        console.error('Copy failed:', err);
      });
    });
  }

  if (elements.exportSelect) {
    elements.exportSelect.addEventListener('change', (e) => {
      selectedExportFormat = e.target.value;
      if (selectedExportFormat === 'pdf' || selectedExportFormat === 'word') {
        if (elements.exportOkBtn) elements.exportOkBtn.style.display = 'inline-block';
      } else {
        if (elements.exportOkBtn) elements.exportOkBtn.style.display = 'none';
      }
    });
  }

  if (elements.exportOkBtn) {
    elements.exportOkBtn.addEventListener('click', () => {
      if (selectedExportFormat === 'pdf') {
        exportToPDF();
      } else if (selectedExportFormat === 'word') {
        exportToWord();
      }
      // Reset dropdown and hide OK button
      if (elements.exportSelect) elements.exportSelect.value = '';
      if (elements.exportOkBtn) elements.exportOkBtn.style.display = 'none';
      selectedExportFormat = '';
    });
  }

  function updateQuotaStatus(quota) {
    if (elements.quotaStatus) {
      if (quota && quota.remaining !== undefined) {
        elements.quotaStatus.textContent = `API Quota: ${quota.remaining} remaining | Resets in ${quota.reset || '?'}s`;
      } else {
        elements.quotaStatus.textContent = '';
      }
    }
  }
});