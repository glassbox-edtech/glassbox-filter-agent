document.getElementById('unblockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const url = document.getElementById('urlInput').value;
    const reason = document.getElementById('reasonInput').value;
    
    // Get the anonymous student hash from local storage
    const data = await chrome.storage.local.get('studentHash');
    const studentHash = data.studentHash || "unknown_student";

    const payload = {
        studentHash: studentHash,
        url: url,
        reason: reason
    };

    console.log("📤 Preparing to send payload to Cloudflare:", payload);
    
    // In the next phase, we will add the fetch() POST command here to hit the Cloudflare Worker.
    // For now, we simulate a successful UI change.
    
    document.getElementById('unblockForm').style.display = 'none';
    document.getElementById('statusMessage').style.display = 'block';
});
