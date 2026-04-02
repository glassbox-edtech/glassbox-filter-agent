// Run setup when the page loads
document.addEventListener('DOMContentLoaded', () => {
    // Try to pre-fill the URL if it was passed as a query parameter (e.g., block.html?url=badsite.test)
    const params = new URLSearchParams(window.location.search);
    const blockedUrl = params.get('url');
    if (blockedUrl) {
        document.getElementById('urlInput').value = blockedUrl;
    }
});

document.getElementById('unblockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const url = document.getElementById('urlInput').value;
    const reason = document.getElementById('reasonInput').value;
    const submitButton = document.querySelector('button[type="submit"]');
    
    // Disable the button to prevent duplicate submissions
    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";
    
    try {
        // 1. Fetch central config for the dynamic URL using Chrome's API
        const configUrl = chrome.runtime.getURL('config.json');
        const configRes = await fetch(configUrl);
        const config = await configRes.json();

        // 🛠️ THE FIX: Clean up the URL by stripping the trailing slash
        const baseUrl = config.workerUrl.endsWith('/') ? config.workerUrl.slice(0, -1) : config.workerUrl;

        // 2. Get the anonymous student hash from local storage
        const data = await chrome.storage.local.get('studentHash');
        const studentHash = data.studentHash || "unknown_student";

        const payload = {
            studentHash: studentHash,
            url: url,
            reason: reason
        };

        console.log("📤 Preparing to send payload to Cloudflare:", payload);
        
        // 3. Send the POST request to our Cloudflare backend using baseUrl
        const response = await fetch(`${baseUrl}/api/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            // Success! Hide the form and show the success message
            document.getElementById('unblockForm').style.display = 'none';
            const statusMsg = document.getElementById('statusMessage');
            statusMsg.style.display = 'block';
            statusMsg.textContent = "✅ Request securely submitted to IT!";
            statusMsg.className = "success"; 
        } else {
            throw new Error(`Server returned status: ${response.status}`);
        }
    } catch (error) {
        console.error("Fetch failed:", error);
        
        // Let the user try again if it failed
        const statusMsg = document.getElementById('statusMessage');
        statusMsg.style.display = 'block';
        statusMsg.textContent = "❌ Failed to submit request. Please check your connection.";
        statusMsg.style.color = "#dc2626";
        statusMsg.style.backgroundColor = "#fee2e2";
        
        submitButton.disabled = false;
        submitButton.textContent = "Submit Unblock Request";
    }
});