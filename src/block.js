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
    const submitButton = document.getElementById('submitBtn');
    const reasonInput = document.getElementById('reasonInput');
    const statusMsg = document.getElementById('statusMessage');
    
    // UI Update: Disable the button and input to prevent duplicate submissions
    submitButton.disabled = true;
    reasonInput.disabled = true;
    submitButton.textContent = "Submitting securely...";
    statusMsg.style.display = 'none'; // Hide any previous error messages
    
    try {
        // 1. Fetch central config for the dynamic URL using Chrome's API
        const configUrl = chrome.runtime.getURL('config.json');
        const configRes = await fetch(configUrl);
        const config = await configRes.json();

        // Clean up the URL by stripping the trailing slash
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
        
        // 3. Send the POST request to our Cloudflare backend
        const response = await fetch(`${baseUrl}/api/filter/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            // Success! Hide the form completely and show the success message
            document.getElementById('unblockForm').style.display = 'none';
            statusMsg.style.display = 'block';
            statusMsg.textContent = "✅ Request securely submitted to IT! You may close this tab.";
            statusMsg.className = "status-message success"; 
        } else {
            throw new Error(`Server returned status: ${response.status}`);
        }
    } catch (error) {
        console.error("Fetch failed:", error);
        
        // Error Recovery: Let the user try again
        statusMsg.style.display = 'block';
        statusMsg.textContent = "❌ Failed to submit request. Please check your network connection and try again.";
        statusMsg.className = "status-message error";
        
        // Re-enable the inputs
        submitButton.disabled = false;
        reasonInput.disabled = false;
        submitButton.textContent = "Submit Unblock Request";
    }
});