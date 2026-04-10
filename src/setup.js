document.addEventListener('DOMContentLoaded', async () => {
    const select = document.getElementById('schoolSelect');
    const btn = document.getElementById('connectBtn');
    const statusMsg = document.getElementById('statusMsg');
    let workerUrl = '';

    function showError(msg) {
        statusMsg.textContent = msg;
        statusMsg.className = 'status error';
    }

    try {
        // 1. Fetch Worker URL from config.json
        const configRes = await fetch(chrome.runtime.getURL('config.json'));
        const config = await configRes.json();
        workerUrl = config.workerUrl.endsWith('/') ? config.workerUrl.slice(0, -1) : config.workerUrl;

        // 2. Fetch the public list of schools
        const schoolsRes = await fetch(`${workerUrl}/api/schools/public`);
        if (!schoolsRes.ok) throw new Error("Could not load schools.");
        
        const data = await schoolsRes.json();
        
        select.innerHTML = '<option value="" disabled selected>-- Select your school --</option>';
        data.schools.forEach(school => {
            const option = document.createElement('option');
            option.value = school.id;
            option.textContent = school.name;
            select.appendChild(option);
        });

        select.disabled = false;

        select.addEventListener('change', () => {
            btn.disabled = !select.value;
        });

    } catch (err) {
        console.error(err);
        showError("Failed to connect to the Glassbox network. Please check your internet connection.");
        select.innerHTML = '<option value="">Network Error</option>';
    }

    // 3. Handle Registration
    btn.addEventListener('click', async () => {
        const schoolId = select.value;
        if (!schoolId) return;

        btn.disabled = true;
        btn.textContent = "Registering...";
        statusMsg.style.display = 'none';

        try {
            // Grab the pre-hashed identity from local storage
            const localData = await chrome.storage.local.get('studentHash');
            if (!localData.studentHash) {
                throw new Error("Identity hash not found. Please restart the extension.");
            }

            // Register with the server (Server-Side Lock enforced here)
            const regRes = await fetch(`${workerUrl}/api/student/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    studentHash: localData.studentHash,
                    schoolId: parseInt(schoolId)
                })
            });

            if (!regRes.ok) {
                const errData = await regRes.json();
                throw new Error(errData.error || "Registration failed.");
            }

            // Success! Save the locked ID to local storage
            await chrome.storage.local.set({ schoolId: parseInt(schoolId) });

            // Update UI
            document.getElementById('setupContainer').style.display = 'none';
            document.getElementById('successContainer').style.display = 'block';

            // 🎯 NEW: Force the background script to run an immediate sync now that we have a schoolId
            chrome.runtime.sendMessage({ action: "force_sync" });

        } catch (err) {
            console.error(err);
            showError(err.message);
            btn.disabled = false;
            btn.textContent = "Connect to School";
        }
    });
});