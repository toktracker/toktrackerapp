/**
 * toktracker – Spender-Radar & Chatlog Controller
 * Handles real-time polling, whale detection, filtering, and dossier inspection.
 */

(function () {
    "use strict";

    // State
    let currentPeriod = "all";
    let selectedStreamerId = "";
    let donorSearch = "";
    let donorTier = "";
    let crossOnly = false;
    let vipOnly = false;
    let currentDossierData = null;
    let currentDossierTags = [];
    let chatSearch = "";
    let whaleOnlyChat = false;
    let chatPaused = false;
    let lastChatId = null;
    let chatMessagesList = [];
    let autoScroll = true;
    let syncIntervalId = null;
    let isFetchingChat = false;

    // Whale Ticker, Audio & Loyalty State
    let whaleMinCoins = 2500;
    let whaleSoundEnabled = true;
    let lastSeenWhaleAlertIds = new Set();
    let isPollingWhaleAlerts = false;
    let audioCtx = null;
    let currentHubView = "leaderboard";
    let loyaltyDaysRecent = 14;
    let isFetchingLoyalty = false;

    // DOM Elements
    const periodButtons = document.querySelectorAll(".tab-list .tab-btn");
    const filterStreamer = document.getElementById("filterStreamer");
    const chkAutoRefresh = document.getElementById("chkAutoRefresh");

    // KPI Elements
    const kpiWhalesCount = document.getElementById("kpiWhalesCount");
    const kpiSharksCount = document.getElementById("kpiSharksCount");
    const kpiDolphinsCount = document.getElementById("kpiDolphinsCount");
    const kpiCrossCount = document.getElementById("kpiCrossCount");
    const kpiVipCount = document.getElementById("kpiVipCount");
    const cardKpiVip = document.getElementById("cardKpiVip");
    const kpiChatCount = document.getElementById("kpiChatCount");

    // Whale Alert & Ticker Elements
    const whaleToastContainer = document.getElementById("whaleToastContainer");
    const whaleTickerScroll = document.getElementById("whaleTickerScroll");
    const selWhaleThreshold = document.getElementById("selWhaleThreshold");
    const btnToggleWhaleSound = document.getElementById("btnToggleWhaleSound");

    // View Switching & Loyalty Hub Elements
    const btnTabLeaderboard = document.getElementById("btnTabLeaderboard");
    const btnTabLoyaltyHub = document.getElementById("btnTabLoyaltyHub");
    const loyaltyHubControls = document.getElementById("loyaltyHubControls");
    const selLoyaltyDays = document.getElementById("selLoyaltyDays");
    const btnRefreshLoyaltyHub = document.getElementById("btnRefreshLoyaltyHub");
    const radarSplitLayout = document.getElementById("radarSplitLayout");
    const loyaltyHubLayout = document.getElementById("loyaltyHubLayout");
    const frontenwechslerBadge = document.getElementById("frontenwechslerBadge");
    const frontenwechslerTableBody = document.getElementById("frontenwechslerTableBody");
    const overlapPairsBadge = document.getElementById("overlapPairsBadge");
    const overlapMatrixBody = document.getElementById("overlapMatrixBody");

    // Donor Elements
    const donorSearchInput = document.getElementById("donorSearchInput");
    const donorTierFilter = document.getElementById("donorTierFilter");
    const chkCrossOnly = document.getElementById("chkCrossOnly");
    const chkVipOnly = document.getElementById("chkVipOnly");
    const donorTableBody = document.getElementById("donorTableBody");

    // Chat Elements
    const chatLiveBadge = document.getElementById("chatLiveBadge");
    const chatMetaCount = document.getElementById("chatMetaCount");
    const chkWhaleOnlyChat = document.getElementById("chkWhaleOnlyChat");
    const chatSearchInput = document.getElementById("chatSearchInput");
    const btnToggleChatPause = document.getElementById("btnToggleChatPause");
    const chatMessagesArea = document.getElementById("chatMessagesArea");
    const btnScrollBottom = document.getElementById("btnScrollBottom");

    // Modal Elements
    const donorModalOverlay = document.getElementById("donorModalOverlay");
    const btnCloseDonorModal = document.getElementById("btnCloseDonorModal");
    const donorModalBody = document.getElementById("donorModalBody");
    const modalDonorTierBadge = document.getElementById("modalDonorTierBadge");
    const modalCrossBadge = document.getElementById("modalCrossBadge");

    // Helper: Number Formatter
    function formatNumber(num) {
        if (num === null || num === undefined) return "0";
        return Number(num).toLocaleString("de-DE");
    }

    function formatCurrency(val, currency = "EUR") {
        if (val === null || val === undefined) return "0,00 €";
        const sym = currency === "USD" ? "$" : "€";
        return Number(val).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + sym;
    }

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatTimestamp(isoStr) {
        if (!isoStr) return "-";
        try {
            const clean = isoStr.replace("T", " ");
            const parts = clean.split(" ");
            if (parts.length >= 2) {
                return parts[1].substring(0, 8);
            }
            return clean;
        } catch (e) {
            return isoStr;
        }
    }

    function renderTierBadge(tier) {
        if (tier === "whale") {
            return `<span class="tier-badge tier-whale">🐋 Whale</span>`;
        } else if (tier === "shark") {
            return `<span class="tier-badge tier-shark">🦈 Shark</span>`;
        } else if (tier === "dolphin") {
            return `<span class="tier-badge tier-dolphin">🐬 Dolphin</span>`;
        }
        return `<span class="tier-badge tier-regular">Viewer</span>`;
    }

    // Web Audio API Synthesizer (Crystal Chime for Whale Alerts)
    function initAudioContext() {
        if (!audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                audioCtx = new AudioContext();
            }
        }
        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume();
        }
    }

    function playWhaleAlertChime() {
        if (!whaleSoundEnabled) return;
        try {
            initAudioContext();
            if (!audioCtx) return;

            const now = audioCtx.currentTime;
            // 3-note ascending crystal chime: D5 (587.33Hz), A5 (880Hz), D6 (1174.66Hz)
            const notes = [
                { freq: 587.33, start: 0, dur: 0.35, gain: 0.14 },
                { freq: 880.00, start: 0.1, dur: 0.4, gain: 0.16 },
                { freq: 1174.66, start: 0.22, dur: 0.65, gain: 0.20 }
            ];

            notes.forEach(n => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();

                osc.type = "sine";
                osc.frequency.setValueAtTime(n.freq, now + n.start);

                gain.gain.setValueAtTime(0.0001, now + n.start);
                gain.gain.exponentialRampToValueAtTime(n.gain, now + n.start + 0.03);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);

                osc.connect(gain);
                gain.connect(audioCtx.destination);

                osc.start(now + n.start);
                osc.stop(now + n.start + n.dur);
            });
        } catch (e) {
            console.warn("Web Audio chime could not play:", e);
        }
    }

    // Initialize Event Listeners
    function initEvents() {
        // Period tabs
        periodButtons.forEach(btn => {
            btn.addEventListener("click", () => {
                periodButtons.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                currentPeriod = btn.dataset.period || "all";
                loadDonorRadarData();
            });
        });

        // Streamer filter
        if (filterStreamer) {
            filterStreamer.addEventListener("change", () => {
                selectedStreamerId = filterStreamer.value;
                loadDonorRadarData();
                resetAndReloadChat();
            });
        }

        // Donor search & filters
        let donorSearchTimeout;
        if (donorSearchInput) {
            donorSearchInput.addEventListener("input", () => {
                clearTimeout(donorSearchTimeout);
                donorSearchTimeout = setTimeout(() => {
                    donorSearch = donorSearchInput.value.trim();
                    loadDonorRadarData();
                }, 300);
            });
        }

        if (donorTierFilter) {
            donorTierFilter.addEventListener("change", () => {
                donorTier = donorTierFilter.value;
                loadDonorRadarData();
            });
        }

        if (chkCrossOnly) {
            chkCrossOnly.addEventListener("change", () => {
                crossOnly = chkCrossOnly.checked;
                loadDonorRadarData();
            });
        }

        if (chkVipOnly) {
            chkVipOnly.addEventListener("change", () => {
                vipOnly = chkVipOnly.checked;
                loadDonorRadarData();
            });
        }

        if (cardKpiVip) {
            cardKpiVip.addEventListener("click", () => {
                if (chkVipOnly) {
                    chkVipOnly.checked = !chkVipOnly.checked;
                    vipOnly = chkVipOnly.checked;
                    loadDonorRadarData();
                }
            });
        }

        // Chat controls
        if (chkWhaleOnlyChat) {
            chkWhaleOnlyChat.addEventListener("change", () => {
                whaleOnlyChat = chkWhaleOnlyChat.checked;
                resetAndReloadChat();
            });
        }

        let chatSearchTimeout;
        if (chatSearchInput) {
            chatSearchInput.addEventListener("input", () => {
                clearTimeout(chatSearchTimeout);
                chatSearchTimeout = setTimeout(() => {
                    chatSearch = chatSearchInput.value.trim();
                    resetAndReloadChat();
                }, 300);
            });
        }

        if (btnToggleChatPause) {
            btnToggleChatPause.addEventListener("click", () => {
                chatPaused = !chatPaused;
                if (chatPaused) {
                    btnToggleChatPause.textContent = "▶ Weiter";
                    chatLiveBadge.textContent = "PAUSIERT";
                    chatLiveBadge.className = "tag-poll mono";
                } else {
                    btnToggleChatPause.textContent = "⏸ Pause";
                    chatLiveBadge.textContent = "LIVE";
                    chatLiveBadge.className = "tag-live mono";
                    pollChatMessages();
                }
            });
        }

        if (btnScrollBottom) {
            btnScrollBottom.addEventListener("click", () => {
                autoScroll = true;
                scrollToBottom();
            });
        }

        if (chatMessagesArea) {
            chatMessagesArea.addEventListener("scroll", () => {
                const threshold = 60;
                const atBottom = chatMessagesArea.scrollHeight - chatMessagesArea.scrollTop - chatMessagesArea.clientHeight < threshold;
                autoScroll = atBottom;
            });
        }

        // Modal close
        if (btnCloseDonorModal) {
            btnCloseDonorModal.addEventListener("click", closeDonorModal);
        }
        if (donorModalOverlay) {
            donorModalOverlay.addEventListener("click", (e) => {
                if (e.target === donorModalOverlay) closeDonorModal();
            });
        }
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeDonorModal();
        });

        // Auto Refresh Toggle
        if (chkAutoRefresh) {
            chkAutoRefresh.addEventListener("change", () => {
                if (chkAutoRefresh.checked) {
                    startSyncLoop();
                } else {
                    stopSyncLoop();
                }
            });
        }

        // Whale Ticker Controls
        if (selWhaleThreshold) {
            selWhaleThreshold.addEventListener("change", () => {
                whaleMinCoins = parseInt(selWhaleThreshold.value, 10) || 2500;
                lastSeenWhaleAlertIds.clear();
                pollWhaleAlerts();
            });
        }

        if (btnToggleWhaleSound) {
            btnToggleWhaleSound.addEventListener("click", () => {
                initAudioContext();
                whaleSoundEnabled = !whaleSoundEnabled;
                if (whaleSoundEnabled) {
                    btnToggleWhaleSound.innerHTML = `<span>🔔 Sound: AN</span>`;
                    btnToggleWhaleSound.style.borderColor = "#a855f7";
                    btnToggleWhaleSound.style.color = "#d8b4fe";
                    playWhaleAlertChime();
                } else {
                    btnToggleWhaleSound.innerHTML = `<span>🔇 Sound: AUS</span>`;
                    btnToggleWhaleSound.style.borderColor = "var(--border-color)";
                    btnToggleWhaleSound.style.color = "var(--text-muted)";
                }
            });
        }

        // View Mode Switcher
        if (btnTabLeaderboard) {
            btnTabLeaderboard.addEventListener("click", () => {
                currentHubView = "leaderboard";
                btnTabLeaderboard.classList.add("active");
                if (btnTabLoyaltyHub) btnTabLoyaltyHub.classList.remove("active");
                if (radarSplitLayout) radarSplitLayout.style.display = "grid";
                if (loyaltyHubLayout) loyaltyHubLayout.style.display = "none";
                if (loyaltyHubControls) loyaltyHubControls.style.display = "none";
            });
        }

        if (btnTabLoyaltyHub) {
            btnTabLoyaltyHub.addEventListener("click", () => {
                currentHubView = "loyalty";
                btnTabLoyaltyHub.classList.add("active");
                if (btnTabLeaderboard) btnTabLeaderboard.classList.remove("active");
                if (radarSplitLayout) radarSplitLayout.style.display = "none";
                if (loyaltyHubLayout) loyaltyHubLayout.style.display = "flex";
                if (loyaltyHubControls) loyaltyHubControls.style.display = "flex";
                loadLoyaltyHubData();
            });
        }

        if (btnRefreshLoyaltyHub) {
            btnRefreshLoyaltyHub.addEventListener("click", () => {
                loadLoyaltyHubData();
            });
        }

        if (selLoyaltyDays) {
            selLoyaltyDays.addEventListener("change", () => {
                loyaltyDaysRecent = parseInt(selLoyaltyDays.value, 10) || 14;
                loadLoyaltyHubData();
            });
        }

        // Global Audio Unlock
        document.addEventListener("click", () => {
            initAudioContext();
        }, { once: true });
    }

    function scrollToBottom() {
        if (!chatMessagesArea) return;
        chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
    }

    // 1. Load Donor Radar Data
    async function loadDonorRadarData() {
        try {
            const params = new URLSearchParams({
                period: currentPeriod,
                limit: "100",
            });
            if (selectedStreamerId) params.append("streamer_id", selectedStreamerId);
            if (donorSearch) params.append("search", donorSearch);
            if (donorTier) params.append("min_tier", donorTier);
            if (crossOnly) params.append("cross_streamer_only", "true");
            if (vipOnly) params.append("vip_only", "true");

            const res = await fetch(`/api/donor-radar?${params.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || "Fehler beim Laden");

            renderKPIs(json.data.kpis);
            renderDonorTable(json.data.donors);
            populateStreamerDropdown(json.data.streamers);
        } catch (err) {
            console.error("Fehler beim Abrufen des Spender-Radars:", err);
            if (donorTableBody) {
                donorTableBody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#f85149; padding:20px;">Fehler beim Laden der Spenderdaten (${escapeHtml(err.message)})</td></tr>`;
            }
        }
    }

    // Render KPIs
    function renderKPIs(kpis) {
        if (!kpis) return;
        if (kpiWhalesCount) kpiWhalesCount.textContent = formatNumber(kpis.whales);
        if (kpiSharksCount) kpiSharksCount.textContent = formatNumber(kpis.sharks);
        if (kpiDolphinsCount) kpiDolphinsCount.textContent = formatNumber(kpis.dolphins);
        if (kpiCrossCount) kpiCrossCount.textContent = formatNumber(kpis.cross_streamer_whales);
        if (kpiVipCount) kpiVipCount.textContent = formatNumber(kpis.vip_donors || 0);
        if (kpiChatCount) kpiChatCount.textContent = formatNumber(kpis.total_chat_messages);
    }

    // Populate Streamers Dropdown
    let streamersPopulated = false;
    function populateStreamerDropdown(streamers) {
        if (streamersPopulated || !streamers || !filterStreamer) return;
        const currentVal = filterStreamer.value;
        filterStreamer.innerHTML = `<option value="">Alle Streamer</option>`;
        streamers.forEach(s => {
            const opt = document.createElement("option");
            opt.value = s.id;
            opt.textContent = `${s.display_name || s.username} (@${s.username})${s.is_live ? " [LIVE]" : ""}`;
            filterStreamer.appendChild(opt);
        });
        filterStreamer.value = currentVal;
        streamersPopulated = true;
    }

    // Render Donor Table
    function renderDonorTable(donors) {
        if (!donorTableBody) return;
        if (!donors || donors.length === 0) {
            donorTableBody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 30px;">Keine Spender für die gewählten Filter gefunden.</td></tr>`;
            return;
        }

        let html = "";
        donors.forEach((d, idx) => {
            const uname = escapeHtml(d.username);
            const dname = escapeHtml(d.display_name || d.username);
            const tierBadge = renderTierBadge(d.tier);
            const crossBadge = d.is_cross_streamer
                ? `<span class="tag-cross-streamer" title="Beschenkt ${d.streamer_count} verschiedene Streamer">⚡ ${d.streamer_count} Kanäle</span>`
                : "";

            const isVip = Boolean(d.is_vip);
            const starTitle = isVip ? "Von VIP-Watchlist entfernen" : "Auf VIP-Watchlist setzen";
            const starChar = isVip ? "★" : "☆";
            const starBtn = `<button type="button" class="vip-star-btn ${isVip ? 'is-vip' : ''}" onclick="window.tokRadar.toggleVipQuick('${uname}', event)" title="${starTitle}">${starChar}</button>`;

            const tagsList = Array.isArray(d.tags) ? d.tags : [];
            const tagsHtml = tagsList.length > 0
                ? tagsList.map(t => `<span class="crm-tag-pill">${escapeHtml(t)}</span>`).join(" ")
                : "";

            const notesIcon = d.has_notes
                ? `<span class="crm-notes-badge" title="Notizen hinterlegt: ${escapeHtml(d.notes || '')}">📝</span>`
                : "";

            html += `
                <tr>
                    <td class="mono muted">${idx + 1}</td>
                    <td class="hide-sm">${tierBadge}</td>
                    <td>
                        <div style="display:flex; align-items:center; gap:8px;">
                            ${starBtn}
                            <div style="display:flex; flex-direction:column;">
                                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                                    <strong style="color:var(--text-strong); cursor:pointer;" onclick="window.tokRadar.openDossier('${uname}')">${dname}</strong>
                                    ${crossBadge}
                                    ${notesIcon}
                                </div>
                                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:2px;">
                                    <span class="mono muted" style="font-size:11px;">@${uname}</span>
                                    ${tagsHtml}
                                </div>
                            </div>
                        </div>
                    </td>
                    <td class="num-col mono" style="font-weight:700; color:#38bdf8;">${formatNumber(d.total_coins)}</td>
                    <td class="num-col mono" style="font-weight:700; color:#4ade80;">${formatCurrency(d.total_eur_net, "EUR")}</td>
                    <td class="num-col mono muted hide-sm">${formatCurrency(d.total_usd_net, "USD")}</td>
                    <td class="num-col mono hide-md">${formatNumber(d.streamer_count)}</td>
                    <td class="mono muted hide-sm" style="font-size:11.5px;">${escapeHtml(d.last_seen || "-")}</td>
                    <td style="text-align: right;">
                        <button type="button" class="btn-link sm" onclick="window.tokRadar.openDossier('${uname}')" style="font-size:11.5px; padding:3px 8px;">
                            Dossier →
                        </button>
                    </td>
                </tr>
            `;
        });

        donorTableBody.innerHTML = html;
    }

    // 2. Chatlogs System
    async function resetAndReloadChat() {
        lastChatId = null;
        chatMessagesList = [];
        if (chatMessagesArea) {
            chatMessagesArea.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:40px;">Lade Chatnachrichten...</div>`;
        }
        await pollChatMessages();
    }

    async function pollChatMessages() {
        if (chatPaused || isFetchingChat) return;
        isFetchingChat = true;

        try {
            const params = new URLSearchParams({
                limit: lastChatId ? "50" : "80",
            });
            if (selectedStreamerId) params.append("streamer_id", selectedStreamerId);
            if (chatSearch) params.append("search", chatSearch);
            if (whaleOnlyChat) params.append("only_whales", "true");
            if (lastChatId) params.append("after_id", lastChatId);

            const res = await fetch(`/api/chat-logs?${params.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || "Fehler");

            const newMsgs = json.messages || [];

            if (!lastChatId) {
                // Initial load: messages came in DESC order, reverse them to chronological (oldest to newest)
                newMsgs.reverse();
                chatMessagesList = newMsgs;
                if (chatMessagesList.length > 0) {
                    lastChatId = chatMessagesList[chatMessagesList.length - 1].id;
                }
                renderAllChatMessages();
            } else if (newMsgs.length > 0) {
                // Live streaming: messages arrived in ASC order
                newMsgs.forEach(m => {
                    chatMessagesList.push(m);
                    appendChatBubble(m);
                });
                // Cap list length to 300
                if (chatMessagesList.length > 300) {
                    chatMessagesList = chatMessagesList.slice(-300);
                    // Remove excess elements from top of DOM
                    while (chatMessagesArea.children.length > 300) {
                        chatMessagesArea.removeChild(chatMessagesArea.firstElementChild);
                    }
                }
                lastChatId = newMsgs[newMsgs.length - 1].id;
                if (autoScroll) scrollToBottom();
            }

            if (chatMetaCount) {
                chatMetaCount.textContent = `${chatMessagesList.length} Nachrichten`;
            }
        } catch (err) {
            console.error("Fehler beim Abrufen der Chatnachrichten:", err);
        } finally {
            isFetchingChat = false;
        }
    }

    function renderAllChatMessages() {
        if (!chatMessagesArea) return;
        if (chatMessagesList.length === 0) {
            chatMessagesArea.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:40px;">Noch keine Chatnachrichten aufgezeichnet. Sobald ein Streamer live ist, erscheinen Nachrichten hier in Echtzeit.</div>`;
            return;
        }

        let html = "";
        chatMessagesList.forEach(m => {
            html += generateChatBubbleHtml(m);
        });
        chatMessagesArea.innerHTML = html;
        if (autoScroll) scrollToBottom();
    }

    function appendChatBubble(m) {
        if (!chatMessagesArea) return;
        // If empty placeholder is shown, clear it
        if (chatMessagesList.length === 1) {
            chatMessagesArea.innerHTML = "";
        }
        const temp = document.createElement("div");
        temp.innerHTML = generateChatBubbleHtml(m);
        const bubbleEl = temp.firstElementChild;
        if (bubbleEl) {
            chatMessagesArea.appendChild(bubbleEl);
        }
    }

    function generateChatBubbleHtml(m) {
        const tier = m.whale_tier || (m.is_whale ? "dolphin" : "");
        const tierBadge = tier ? renderTierBadge(tier) : "";
        const bubbleClass = tier ? `chat-bubble bubble-${tier}` : "chat-bubble";
        const uname = escapeHtml(m.username);
        const nick = escapeHtml(m.nickname || m.username);
        const comment = escapeHtml(m.comment);
        const timeStr = formatTimestamp(m.created_at);
        const streamerName = escapeHtml(m.streamer_display_name || m.streamer_username || "");

        const avatar = m.avatar_url
            ? `<img src="${escapeHtml(m.avatar_url)}" class="chat-avatar" alt="" onerror="this.style.display='none'" />`
            : `<div class="chat-avatar" style="display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--text-muted);">${uname.charAt(0).toUpperCase()}</div>`;

        return `
            <div class="${bubbleClass}">
                <div class="chat-user-line">
                    <div class="chat-user-info">
                        ${avatar}
                        <span class="chat-donor-link" onclick="window.tokRadar.openDossier('${uname}')" title="Spender-Dossier öffnen">${nick}</span>
                        <span class="mono muted" style="font-size:11px;">@${uname}</span>
                        ${tierBadge}
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span class="chat-streamer-badge" title="Stream">@${streamerName}</span>
                        <span class="chat-time">${timeStr}</span>
                    </div>
                </div>
                <div class="chat-text">${comment}</div>
            </div>
        `;
    }

    // 3. Spender-Dossier Modal
    async function openDossier(username) {
        if (!donorModalOverlay || !donorModalBody) return;
        donorModalOverlay.style.display = "flex";
        donorModalBody.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:40px;">Lade Spender-Dossier für @${escapeHtml(username)}...</div>`;
        if (modalDonorTierBadge) modalDonorTierBadge.innerHTML = "";
        if (modalCrossBadge) modalCrossBadge.innerHTML = "";

        try {
            const res = await fetch(`/api/donor-radar/donors/${encodeURIComponent(username)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok || !json.data) throw new Error(json.error || "Nicht gefunden");

            renderDonorDossier(json.data);
        } catch (err) {
            console.error("Dossier-Fehler:", err);
            donorModalBody.innerHTML = `<div style="text-align:center; color:#f85149; padding:30px;">Fehler beim Laden des Dossiers (${escapeHtml(err.message)})</div>`;
        }
    }

    function renderDonorDossier(data) {
        const p = data.profile;
        if (!p) return;

        if (modalDonorTierBadge) {
            modalDonorTierBadge.innerHTML = renderTierBadge(p.tier);
        }
        if (modalCrossBadge) {
            modalCrossBadge.innerHTML = p.is_cross_streamer
                ? `<span class="tag-cross-streamer">⚡ Cross-Streamer (${p.streamer_count} Kanäle)</span>`
                : "";
        }

        const avatar = p.avatar_url
            ? `<img src="${escapeHtml(p.avatar_url)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid var(--border-strong);" alt="" onerror="this.style.display='none'" />`
            : `<div style="width:48px;height:48px;border-radius:50%;background:var(--bg-subtle);border:2px solid var(--border-color);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:var(--text-muted);">${(p.username||"?").charAt(0).toUpperCase()}</div>`;

        // Streamers breakdown table
        let streamersHtml = "";
        if (data.streamers && data.streamers.length > 0) {
            data.streamers.forEach(s => {
                const sName = escapeHtml(s.streamer_display_name || s.streamer_username);
                const sUname = escapeHtml(s.streamer_username);
                streamersHtml += `
                    <tr>
                        <td>
                            <strong style="color:var(--text-strong);">${sName}</strong>
                            <span class="mono muted" style="font-size:11px; margin-left:4px;">@${sUname}</span>
                        </td>
                        <td class="num-col mono" style="font-weight:700; color:#38bdf8;">${formatNumber(s.coins_given)}</td>
                        <td class="num-col mono" style="color:#4ade80;">${formatCurrency(s.eur_net, "EUR")}</td>
                        <td class="num-col mono">${formatNumber(s.gift_count)}</td>
                        <td class="mono muted" style="font-size:11px;">${escapeHtml(s.last_gift_at || "-")}</td>
                    </tr>
                `;
            });
        } else {
            streamersHtml = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:14px;">Bisher keine Geschenke zugeordnet.</td></tr>`;
        }

        // Top gifts list
        let giftsHtml = "";
        if (data.top_gifts && data.top_gifts.length > 0) {
            data.top_gifts.forEach(g => {
                const icon = g.gift_icon_url
                    ? `<img src="${escapeHtml(g.gift_icon_url)}" style="width:24px;height:24px;object-fit:contain;" alt="" onerror="this.style.display='none'" />`
                    : `<span style="font-size:16px;">🎁</span>`;
                giftsHtml += `
                    <div style="background:var(--bg-subtle); border:1px solid var(--border-color); border-radius:6px; padding:10px; display:flex; align-items:center; justify-content:space-between;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            ${icon}
                            <div>
                                <strong style="font-size:12.5px;">${escapeHtml(g.gift_name)}</strong>
                                <div class="mono muted" style="font-size:11px;">${formatNumber(g.total_sent)}x gesendet</div>
                            </div>
                        </div>
                        <div class="mono" style="font-weight:700; color:#38bdf8; font-size:12.5px;">
                            ${formatNumber(g.total_coins)} Coins
                        </div>
                    </div>
                `;
            });
        } else {
            giftsHtml = `<div style="color:var(--text-muted); font-size:12px; grid-column:1/-1;">Keine spezifischen Geschenke erfasst.</div>`;
        }

        // Recent chat comments
        let chatsHtml = "";
        if (data.recent_chats && data.recent_chats.length > 0) {
            data.recent_chats.forEach(c => {
                chatsHtml += `
                    <div style="background:var(--bg-subtle); border:1px solid var(--border-subtle); border-radius:4px; padding:8px 10px; font-size:12px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:10.5px; color:var(--text-muted);">
                            <span class="mono">Stream: @${escapeHtml(c.streamer_username)}</span>
                            <span class="mono">${formatTimestamp(c.created_at)}</span>
                        </div>
                        <div style="color:var(--text-main); line-height:1.35;">${escapeHtml(c.comment)}</div>
                    </div>
                `;
            });
        } else {
            chatsHtml = `<div style="color:var(--text-muted); font-size:12px;">Keine Chatnachrichten in den letzten 7 Tagen archiviert.</div>`;
        }

        // CRM & Dossier State
        currentDossierData = data;
        const crm = data.crm || { is_vip: false, tags: [], notes: "", updated_at: null };
        currentDossierTags = Array.isArray(crm.tags) ? [...crm.tags] : [];

        donorModalBody.innerHTML = `
            <!-- Top Profile Card -->
            <div style="background:var(--bg-subtle); border:1px solid var(--border-color); border-radius:8px; padding:16px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:16px;">
                <div style="display:flex; align-items:center; gap:14px;">
                    ${avatar}
                    <div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <h3 style="margin:0; font-size:18px; color:var(--text-strong);">${escapeHtml(p.display_name)}</h3>
                            <button type="button" class="vip-star-btn ${crm.is_vip ? 'is-vip' : ''}" onclick="window.tokRadar.toggleModalVip()" title="VIP-Status umschalten" style="font-size:18px;">
                                ${crm.is_vip ? '★' : '☆'}
                            </button>
                        </div>
                        <div class="mono muted" style="font-size:12px;">@${escapeHtml(p.username)}</div>
                        <div style="margin-top:4px; font-size:11.5px; color:var(--text-muted);">
                            Aktiv: <span class="mono">${escapeHtml(p.first_seen || "-")}</span> bis <span class="mono">${escapeHtml(p.last_seen || "-")}</span>
                        </div>
                    </div>
                </div>

                <div style="display:flex; gap:16px; flex-wrap:wrap;">
                    <div style="text-align:right;">
                        <div class="mono muted" style="font-size:11px;">GESAMT COINS</div>
                        <div class="mono" style="font-size:20px; font-weight:800; color:#38bdf8;">${formatNumber(p.total_coins)}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="mono muted" style="font-size:11px;">NETTO (CREATOR)</div>
                        <div class="mono" style="font-size:20px; font-weight:800; color:#4ade80;">${formatCurrency(p.total_eur_net, "EUR")}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="mono muted" style="font-size:11px;">BRUTTO (KAUF)</div>
                        <div class="mono" style="font-size:20px; font-weight:800; color:#fbbf24;">${formatCurrency(p.total_eur_gross, "EUR")}</div>
                    </div>
                </div>
            </div>

            <!-- CRM & VIP Watchlist Section -->
            <div class="crm-card">
                <div class="crm-card-header">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size:16px;">⭐</span>
                        <strong style="font-size:14px; color:var(--text-strong);">Gifter-CRM &amp; VIP-Watchlist</strong>
                        <span id="crmSaveStatus" class="mono" style="font-size:11px; color:#4ade80; display:none; margin-left:6px; font-weight:700;">✓ Gespeichert</span>
                    </div>
                    <button type="button" id="modalBtnToggleVip" class="crm-vip-toggle ${crm.is_vip ? 'active' : ''}" onclick="window.tokRadar.toggleModalVip()">
                        ${crm.is_vip ? '★ Auf VIP-Watchlist' : '☆ Nicht auf Watchlist'}
                    </button>
                </div>

                <!-- Tags Management -->
                <div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <span style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Tags &amp; Einstufung:</span>
                    </div>
                    <div id="modalActiveTags" style="display:flex; flex-wrap:wrap; gap:6px; min-height:24px; align-items:center;">
                        ${renderModalTagsHtml(currentDossierTags)}
                    </div>
                    
                    <!-- Quick Tag Suggestions & Custom Input -->
                    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-top:10px;">
                        <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
                            <span class="mono muted" style="font-size:10.5px;">Vorschläge:</span>
                            <span class="crm-quick-tag" onclick="window.tokRadar.addModalTag('Mega-Wal')">+ Mega-Wal</span>
                            <span class="crm-quick-tag" onclick="window.tokRadar.addModalTag('Agentur-Chef')">+ Agentur-Chef</span>
                            <span class="crm-quick-tag" onclick="window.tokRadar.addModalTag('Match-Sniper')">+ Match-Sniper</span>
                            <span class="crm-quick-tag" onclick="window.tokRadar.addModalTag('Stamm-Gifter')">+ Stamm-Gifter</span>
                            <span class="crm-quick-tag" onclick="window.tokRadar.addModalTag('High-Roller')">+ High-Roller</span>
                            <span class="crm-quick-tag" onclick="window.tokRadar.addModalTag('Troll/Fake')">+ Troll/Fake</span>
                        </div>

                        <div style="display:flex; align-items:center; gap:6px;">
                            <input type="text" id="modalNewTagInput" placeholder="Neuer Tag..." style="padding:4px 8px; font-size:11.5px; background:var(--bg-surface); color:var(--text-main); border:1px solid var(--border-color); border-radius:4px; width:130px;" onkeydown="if(event.key==='Enter'){event.preventDefault(); window.tokRadar.addCustomModalTag();}" />
                            <button type="button" class="btn-link sm" onclick="window.tokRadar.addCustomModalTag()" style="padding:3px 8px; font-size:11.5px;">+ Tag</button>
                        </div>
                    </div>
                </div>

                <!-- Notes Management -->
                <div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <label for="modalNotesTextarea" style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Interne Admin-Notizen:</label>
                        <span class="mono muted" style="font-size:10.5px;">Stand: <span id="modalCrmUpdated">${escapeHtml(crm.updated_at ? formatTimestamp(crm.updated_at) : 'Keine')}</span></span>
                    </div>
                    <textarea id="modalNotesTextarea" class="crm-notes-textarea" placeholder="Interne Notizen zu diesem Spender (z. B. Streamer-Präferenzen, Taktik bei Matches, Agentur-Zugehörigkeit, Hintergrundinfos)...">${escapeHtml(crm.notes || "")}</textarea>
                    <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                        <button type="button" id="btnSaveCrmNotes" class="btn-link primary sm" onclick="window.tokRadar.saveModalCrm(true)" style="padding:5px 14px; font-size:12px;">
                            💾 Notizen &amp; Tags speichern
                        </button>
                    </div>
                </div>
            </div>

            <!-- Section: Loyalität & Frontenwechsler Analyse -->
            ${renderModalLoyaltyCard(data.loyalty)}

            <!-- Section 1: Streamer Breakdown -->
            <div>
                <h4 style="margin:0 0 10px 0; font-size:14px; display:flex; align-items:center; gap:6px;">
                    <span>📊 Geschenke pro Streamer</span>
                    <span class="mono muted" style="font-size:11px;">(${data.streamers ? data.streamers.length : 0} Kanäle)</span>
                </h4>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Streamer</th>
                                <th class="num-col">Coins</th>
                                <th class="num-col">Netto (EUR)</th>
                                <th class="num-col">Geschenke</th>
                                <th>Letztes Geschenk</th>
                            </tr>
                        </thead>
                        <tbody>${streamersHtml}</tbody>
                    </table>
                </div>
            </div>

            <!-- Section 2: Top Gifts -->
            <div>
                <h4 style="margin:0 0 10px 0; font-size:14px;">🎁 Lieblingsgeschenke</h4>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
                    ${giftsHtml}
                </div>
            </div>

            <!-- Section 3: Recent Chat Messages -->
            <div>
                <h4 style="margin:0 0 10px 0; font-size:14px;">💬 Letzte Chat-Nachrichten (Archiv)</h4>
                <div style="display:flex; flex-direction:column; gap:8px; max-height:220px; overflow-y:auto; padding-right:4px;">
                    ${chatsHtml}
                </div>
            </div>
        `;
    }

    function renderModalLoyaltyCard(loyalty) {
        if (!loyalty) return "";

        const score = loyalty.score !== undefined ? loyalty.score : 50;
        const color = loyalty.color || "#38bdf8";
        const label = escapeHtml(loyalty.label || "Spender");
        const classification = loyalty.classification || "multi";
        const primaryName = escapeHtml(loyalty.primary_streamer || "-");
        const primaryRatio = loyalty.primary_ratio ? Math.round(loyalty.primary_ratio * 100) : 0;
        const streamerCount = loyalty.streamer_count || 1;

        let frontenwechselHtml = "";
        const fw = loyalty.frontenwechsel;
        if (fw && fw.shifted) {
            const oldStreamer = escapeHtml(fw.old_streamer || "Vorheriger Streamer");
            const newStreamer = escapeHtml(fw.new_streamer || "Neuer Streamer");
            const oldCoins = formatNumber(fw.old_coins || 0);
            const newCoins = formatNumber(fw.new_coins || 0);

            frontenwechselHtml = `
                <div style="margin-top: 12px; padding: 10px 14px; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">🔀</span>
                        <div>
                            <div style="font-size: 12.5px; font-weight: 700; color: #fca5a5;">
                                Frontenwechsel erkannt: Fokus-Verschiebung
                            </div>
                            <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">
                                Früherer Haupt-Streamer: <strong style="color:var(--text-strong);">@${oldStreamer}</strong> (${oldCoins} Coins)
                                ➔ Neuer Fokus: <strong style="color:#4ade80;">@${newStreamer}</strong> (${newCoins} Coins)
                            </div>
                        </div>
                    </div>
                    <span class="tag-shifter">FRONTENWECHSLER</span>
                </div>
            `;
        }

        return `
            <div class="crm-card" style="border-left: 3px solid ${color};">
                <div class="crm-card-header">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 16px;">🎯</span>
                        <strong style="font-size: 14px; color: var(--text-strong);">Loyalitäts- &amp; Kanal-Bindung</strong>
                    </div>
                    <span class="mono" style="font-size: 12px; font-weight: 700; color: ${color}; background: rgba(255,255,255,0.06); padding: 3px 10px; border-radius: 4px; border: 1px solid var(--border-subtle);">
                        ${label} (${score}%)
                    </span>
                </div>

                <div>
                    <div style="display: flex; justify-content: space-between; font-size: 11.5px; margin-bottom: 4px;">
                        <span style="color: var(--text-muted);">Loyalitäts-Grad (Netzwerkweit):</span>
                        <span class="mono" style="font-weight: 700; color: ${color};">${score} / 100</span>
                    </div>
                    <div class="loyalty-progress-wrap">
                        <div class="loyalty-progress-bar" style="width: ${Math.max(5, Math.min(100, score))}%; background: ${color};"></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-top: 6px;">
                        <span>Haupt-Streamer: <strong style="color: var(--text-strong);">@${primaryName}</strong> (${primaryRatio}% aller Coins)</span>
                        <span>Verteilung: <span class="mono">${streamerCount} ${streamerCount === 1 ? 'Kanal' : 'Kanäle'}</span></span>
                    </div>
                </div>

                ${frontenwechselHtml}
            </div>
        `;
    }

    function renderModalTagsHtml(tags) {
        if (!tags || tags.length === 0) {
            return `<span class="mono muted" style="font-size:11px;">Keine Tags zugewiesen. Wähle unten einen Vorschlag oder erstelle einen neuen Tag.</span>`;
        }
        return tags.map((t, idx) => `
            <span class="crm-tag-pill">
                ${escapeHtml(t)}
                <span class="tag-del-btn" onclick="window.tokRadar.removeModalTag(${idx})" title="Tag entfernen">×</span>
            </span>
        `).join("");
    }

    // Quick toggle VIP from Table
    async function toggleVipQuick(username, evt) {
        if (evt) evt.stopPropagation();
        try {
            const btn = evt ? evt.currentTarget : null;
            if (btn) btn.style.transform = "scale(1.4)";
            const res = await fetch(`/api/donor-radar/donors/${encodeURIComponent(username)}/toggle-vip`, {
                method: "POST"
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.ok) {
                loadDonorRadarData();
            }
        } catch (e) {
            console.error("Fehler beim Umschalten des VIP-Status:", e);
        }
    }

    // Toggle VIP inside Dossier Modal
    async function toggleModalVip() {
        if (!currentDossierData || !currentDossierData.profile) return;
        const uname = currentDossierData.profile.username;
        try {
            const res = await fetch(`/api/donor-radar/donors/${encodeURIComponent(uname)}/toggle-vip`, {
                method: "POST"
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.ok && json.data) {
                currentDossierData.crm = json.data;
                const isVip = Boolean(json.data.is_vip);
                const btn = document.getElementById("modalBtnToggleVip");
                if (btn) {
                    btn.className = `crm-vip-toggle ${isVip ? 'active' : ''}`;
                    btn.innerHTML = isVip ? '★ Auf VIP-Watchlist' : '☆ Nicht auf Watchlist';
                }
                showCrmSaveStatus();
                loadDonorRadarData();
            }
        } catch (e) {
            console.error("Fehler beim Umschalten des VIP-Status:", e);
        }
    }

    // Add Tag
    function addModalTag(tag) {
        const cleanTag = String(tag || "").trim().replace(/,/g, "");
        if (!cleanTag) return;
        if (!currentDossierTags.includes(cleanTag)) {
            currentDossierTags.push(cleanTag);
            const container = document.getElementById("modalActiveTags");
            if (container) container.innerHTML = renderModalTagsHtml(currentDossierTags);
            saveModalCrm(false);
        }
    }

    function addCustomModalTag() {
        const input = document.getElementById("modalNewTagInput");
        if (!input) return;
        const val = input.value.trim();
        if (val) {
            addModalTag(val);
            input.value = "";
        }
    }

    function removeModalTag(idx) {
        if (idx >= 0 && idx < currentDossierTags.length) {
            currentDossierTags.splice(idx, 1);
            const container = document.getElementById("modalActiveTags");
            if (container) container.innerHTML = renderModalTagsHtml(currentDossierTags);
            saveModalCrm(false);
        }
    }

    // Save Notes & Tags
    async function saveModalCrm(showNotification = true) {
        if (!currentDossierData || !currentDossierData.profile) return;
        const uname = currentDossierData.profile.username;
        const textarea = document.getElementById("modalNotesTextarea");
        const notes = textarea ? textarea.value.trim() : (currentDossierData.crm ? currentDossierData.crm.notes : "");

        try {
            const res = await fetch(`/api/donor-radar/donors/${encodeURIComponent(uname)}/crm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    is_vip: currentDossierData.crm ? currentDossierData.crm.is_vip : false,
                    tags: currentDossierTags,
                    notes: notes,
                })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.ok && json.data) {
                currentDossierData.crm = json.data;
                const updatedSpan = document.getElementById("modalCrmUpdated");
                if (updatedSpan && json.data.updated_at) {
                    updatedSpan.textContent = formatTimestamp(json.data.updated_at);
                }
                if (showNotification) {
                    showCrmSaveStatus();
                }
                loadDonorRadarData();
            }
        } catch (e) {
            console.error("Fehler beim Speichern der CRM-Daten:", e);
            if (showNotification) alert("Fehler beim Speichern der Notizen.");
        }
    }

    function showCrmSaveStatus() {
        const el = document.getElementById("crmSaveStatus");
        if (!el) return;
        el.style.display = "inline";
        el.style.opacity = "1";
        setTimeout(() => {
            el.style.display = "none";
        }, 2500);
    }

    function closeDonorModal() {
        if (donorModalOverlay) donorModalOverlay.style.display = "none";
    }

    // =========================================================================
    // 4. Live-Whale-Alert & Ticker System
    // =========================================================================

    async function pollWhaleAlerts() {
        if (isPollingWhaleAlerts) return;
        isPollingWhaleAlerts = true;

        try {
            const res = await fetch(`/api/donor-radar/whale-alerts?min_coins=${whaleMinCoins}&limit=25`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || "Fehler");

            const alerts = json.alerts || [];

            if (lastSeenWhaleAlertIds.size === 0) {
                // First initialization: record current IDs so we don't spam toasts
                alerts.forEach(a => lastSeenWhaleAlertIds.add(a.id));
                renderWhaleTicker(alerts);
            } else {
                // Identify brand new alerts
                const newAlerts = alerts.filter(a => !lastSeenWhaleAlertIds.has(a.id));
                if (newAlerts.length > 0) {
                    newAlerts.forEach(a => {
                        lastSeenWhaleAlertIds.add(a.id);
                        showWhaleToast(a);
                    });
                    playWhaleAlertChime();
                    renderWhaleTicker(alerts);
                }
            }
        } catch (e) {
            console.error("Fehler beim Abrufen der Whale-Alerts:", e);
        } finally {
            isPollingWhaleAlerts = false;
        }
    }

    function renderWhaleTicker(alerts) {
        if (!whaleTickerScroll) return;
        if (!alerts || alerts.length === 0) {
            whaleTickerScroll.innerHTML = `<span class="mono muted" style="font-size:11.5px; padding: 4px 8px;">Keine Whale-Events &ge; ${formatNumber(whaleMinCoins)} Coins in den letzten Aufzeichnungen.</span>`;
            return;
        }

        let html = "";
        alerts.forEach(a => {
            const coins = Number(a.total_coins || a.total_diamonds || 0);
            const uname = escapeHtml(a.sender_username || "");
            const nick = escapeHtml(a.sender_nickname || uname);
            const gift = escapeHtml(a.gift_name || "Geschenk");
            const repeat = a.repeat_count > 1 ? ` x${a.repeat_count}` : "";
            const streamer = escapeHtml(a.streamer_display_name || a.streamer_username || "");
            const eur = a.eur_net !== undefined ? a.eur_net : (coins * 0.005);
            const time = formatTimestamp(a.timestamp);
            const tier = a.tier || (coins >= 10000 ? "whale" : "shark");
            const badge = tier === "whale" ? "🐋" : "🦈";
            const vipStar = a.is_vip ? `<span style="color:#fbbf24; font-size:12px; margin-right:2px;">★</span>` : "";

            html += `
                <div class="whale-ticker-chip" onclick="window.tokRadar.openDossier('${uname}')" title="Klicken für Spender-Dossier">
                    <span>${badge}</span>
                    ${vipStar}
                    <strong style="color:var(--text-strong);">${nick}</strong>
                    <span class="mono muted" style="font-size:11px;">@${uname}</span>
                    <span style="color:var(--text-muted);">schenkte</span>
                    <span class="tag-live mono" style="font-size:10.5px; background:rgba(168,85,247,0.2); border:1px solid rgba(168,85,247,0.5); color:#d8b4fe;">${gift}${repeat}</span>
                    <span class="mono" style="color:#38bdf8; font-weight:700;">${formatNumber(coins)} Coins</span>
                    <span class="mono muted" style="font-size:10.5px;">(~${formatCurrency(eur, "EUR")})</span>
                    <span style="color:var(--text-muted);">→ @${streamer}</span>
                    <span class="mono muted" style="font-size:10px; margin-left:4px;">${time}</span>
                </div>
            `;
        });

        whaleTickerScroll.innerHTML = html;
    }

    function showWhaleToast(alert) {
        if (!whaleToastContainer) return;

        const toast = document.createElement("div");
        toast.className = "whale-toast";

        const coins = Number(alert.total_coins || alert.total_diamonds || 0);
        const eurNet = alert.eur_net !== undefined ? alert.eur_net : (coins * 0.005);
        const tierIcon = coins >= 30000 ? "👑" : coins >= 10000 ? "🐋" : "🦈";
        const streamerName = escapeHtml(alert.streamer_display_name || alert.streamer_username || "Streamer");
        const uname = escapeHtml(alert.sender_username || "Anonym");
        const nick = escapeHtml(alert.sender_nickname || uname);
        const giftName = escapeHtml(alert.gift_name || "Geschenk");
        const repeat = alert.repeat_count > 1 ? ` x${alert.repeat_count}` : "";

        toast.innerHTML = `
            <span class="whale-toast-icon">${tierIcon}</span>
            <div class="whale-toast-content">
                <div class="whale-toast-title">
                    <span>WHALE ALERT: <strong>${giftName}${repeat}</strong></span>
                    <span class="mono" style="color: #fbbf24;">${formatNumber(coins)} Coins (~${formatCurrency(eurNet, "EUR")})</span>
                </div>
                <div class="whale-toast-msg">
                    <span class="chat-donor-link" style="font-weight:700; color:#38bdf8;" onclick="window.tokRadar.openDossier('${uname}')">${nick}</span>
                    <span class="mono muted" style="font-size:11px;">(@${uname})</span>
                    <span>hat an</span>
                    <strong style="color:var(--text-strong);">@${streamerName}</strong>
                    <span>gesendet!</span>
                </div>
            </div>
            <button type="button" class="whale-toast-close" title="Schließen">✕</button>
        `;

        const closeBtn = toast.querySelector(".whale-toast-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", () => {
                toast.style.animation = "toastOut 0.3s forwards ease";
                setTimeout(() => toast.remove(), 300);
            });
        }

        whaleToastContainer.appendChild(toast);

        // Auto remove after 7.5 seconds
        setTimeout(() => {
            if (toast.parentNode) {
                toast.style.opacity = "0";
                toast.style.transform = "translateX(50px)";
                toast.style.transition = "all 0.4s ease";
                setTimeout(() => toast.remove(), 400);
            }
        }, 7500);
    }

    // =========================================================================
    // 5. Loyalitäts- & Frontenwechsler Hub
    // =========================================================================

    function renderDonorItemTags(tags) {
        if (!tags || !Array.isArray(tags) || tags.length === 0) return "";
        return tags.map(t => `<span class="crm-tag-pill" style="font-size:10px; padding:1px 6px;">${escapeHtml(t)}</span>`).join(" ");
    }

    async function loadLoyaltyHubData() {
        if (isFetchingLoyalty) return;
        isFetchingLoyalty = true;

        if (frontenwechslerTableBody) {
            frontenwechslerTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:30px;">Berechne Frontenwechsler...</td></tr>`;
        }
        if (overlapMatrixBody) {
            overlapMatrixBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:30px;">Berechne Überschneidungs-Matrix...</td></tr>`;
        }

        try {
            const days = selLoyaltyDays ? selLoyaltyDays.value : loyaltyDaysRecent;
            const res = await fetch(`/api/donor-radar/loyalty-and-overlap?days_recent=${days}&min_coins=50`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.ok || !json.data) throw new Error(json.error || "Fehler beim Laden");

            const fwList = json.data.frontenwechsler || [];
            const overlapList = json.data.overlap_matrix || [];

            // 1. Render Frontenwechsler Table
            if (frontenwechslerBadge) {
                frontenwechslerBadge.textContent = `${fwList.length} Erkannt`;
            }
            if (frontenwechslerTableBody) {
                if (fwList.length === 0) {
                    frontenwechslerTableBody.innerHTML = `
                        <tr>
                            <td colspan="8" style="text-align:center; color:var(--text-muted); padding:30px;">
                                Keine Frontenwechsler im gewählten Zeitraum (${days} Tage) erkannt. Großspender bleiben bisher ihren Stamm-Kanälen treu.
                            </td>
                        </tr>
                    `;
                } else {
                    let html = "";
                    fwList.forEach(fw => {
                        const uname = escapeHtml(fw.username);
                        const nick = escapeHtml(fw.display_name || fw.username);
                        const crm = fw.crm || { is_vip: false, tags: [] };
                        const vipStar = `<button type="button" class="vip-star-btn ${crm.is_vip ? 'is-vip' : ''}" onclick="window.tokRadar.toggleVipQuick('${uname}', event)" title="VIP-Status umschalten">${crm.is_vip ? '★' : '☆'}</button>`;
                        const tierBadge = renderTierBadge(fw.tier);
                        const tagsHtml = renderDonorItemTags(crm.tags);
                        const shift = fw.frontenwechsel || {};
                        const oldStreamer = escapeHtml(shift.old_streamer || (fw.from_streamer ? fw.from_streamer.username : "-"));
                        const newStreamer = escapeHtml(shift.new_streamer || (fw.to_streamer ? fw.to_streamer.username : "-"));
                        const oldAvatarUrl = shift.old_streamer_avatar || (fw.from_streamer ? fw.from_streamer.avatar_url : "");
                        const newAvatarUrl = shift.new_streamer_avatar || (fw.to_streamer ? fw.to_streamer.avatar_url : "");

                        const oldAvatar = oldAvatarUrl
                            ? `<img src="${escapeHtml(oldAvatarUrl)}" class="chat-avatar" style="width:20px;height:20px;min-width:20px;min-height:20px;max-width:20px;max-height:20px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border-color);" alt="" onerror="this.style.display='none'" />`
                            : "";
                        const newAvatar = newAvatarUrl
                            ? `<img src="${escapeHtml(newAvatarUrl)}" class="chat-avatar" style="width:20px;height:20px;min-width:20px;min-height:20px;max-width:20px;max-height:20px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border-color);" alt="" onerror="this.style.display='none'" />`
                            : "";

                        const oldCoins = formatNumber(shift.old_coins !== undefined ? shift.old_coins : (fw.from_streamer ? fw.from_streamer.coins : 0));
                        const newCoins = formatNumber(shift.new_coins !== undefined ? shift.new_coins : (fw.to_streamer ? fw.to_streamer.coins : 0));
                        const score = fw.loyalty_score !== undefined ? fw.loyalty_score : 50;
                        const scoreColor = fw.color || "#eab308";
                        const scoreLabel = escapeHtml(fw.label || "Multi-Streamer");

                        const avatar = fw.avatar_url
                            ? `<img src="${escapeHtml(fw.avatar_url)}" class="donor-avatar" style="width:32px;height:32px;min-width:32px;min-height:32px;max-width:32px;max-height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border-color);" alt="" onerror="this.style.display='none'" />`
                            : `<div class="donor-avatar" style="width:32px;height:32px;min-width:32px;min-height:32px;max-width:32px;max-height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text-muted);background:var(--bg-surface);border:1px solid var(--border-color);flex-shrink:0;">${uname.charAt(0).toUpperCase()}</div>`;

                        html += `
                            <tr>
                                <td>
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        ${avatar}
                                        <div>
                                            <div class="donor-link" onclick="window.tokRadar.openDossier('${uname}')">${nick}</div>
                                            <div class="mono muted" style="font-size:11px;">@${uname}</div>
                                        </div>
                                    </div>
                                </td>
                                <td>
                                    <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
                                        ${vipStar}
                                        ${tierBadge}
                                    </div>
                                    ${tagsHtml}
                                </td>
                                <td>
                                    <div style="display:flex; align-items:center; gap:6px;">
                                        ${oldAvatar}
                                        <span class="mono muted" style="font-size:11px;">Früher:</span>
                                        <strong style="color:var(--text-strong);">@${oldStreamer}</strong>
                                    </div>
                                </td>
                                <td>
                                    <div style="display:flex; align-items:center; gap:6px;">
                                        ${newAvatar}
                                        <span class="mono" style="font-size:11px; color:#4ade80;">➔ Neu:</span>
                                        <strong style="color:#4ade80;">@${newStreamer}</strong>
                                    </div>
                                </td>
                                <td style="text-align:right;">
                                    <span class="mono" style="color:var(--text-muted);">${oldCoins}</span>
                                </td>
                                <td style="text-align:right;">
                                    <span class="mono" style="font-weight:700; color:#38bdf8;">${newCoins}</span>
                                </td>
                                <td>
                                    <div style="min-width:130px;">
                                        <div style="display:flex; justify-content:space-between; font-size:10.5px; margin-bottom:2px;">
                                            <span style="color:${scoreColor}; font-weight:700;">${scoreLabel}</span>
                                            <span class="mono" style="color:${scoreColor};">${score}%</span>
                                        </div>
                                        <div class="loyalty-progress-wrap" style="height:6px; margin:0;">
                                            <div class="loyalty-progress-bar" style="width:${Math.max(5, Math.min(100, score))}%; background:${scoreColor};"></div>
                                        </div>
                                    </div>
                                </td>
                                <td style="text-align:center;">
                                    <button type="button" class="btn-link sm" onclick="window.tokRadar.openDossier('${uname}')" style="font-size:11px; padding:3px 8px;">
                                        Dossier →
                                    </button>
                                </td>
                            </tr>
                        `;
                    });
                    frontenwechslerTableBody.innerHTML = html;
                }
            }

            // 2. Render Overlap Matrix Table
            if (overlapPairsBadge) {
                overlapPairsBadge.textContent = `${overlapList.length} Kanal-Paare`;
            }
            if (overlapMatrixBody) {
                if (overlapList.length === 0) {
                    overlapMatrixBody.innerHTML = `
                        <tr>
                            <td colspan="6" style="text-align:center; color:var(--text-muted); padding:30px;">
                                Keine Kanal-Überschneidungen mit gemeinsamen Großspendern im Zeitraum gefunden.
                            </td>
                        </tr>
                    `;
                } else {
                    let html = "";
                    overlapList.forEach(pair => {
                        const sA = escapeHtml(pair.streamer_a_display_name || pair.s1_display_name || pair.streamer_a_username || pair.s1_username || "Streamer A");
                        const sB = escapeHtml(pair.streamer_b_display_name || pair.s2_display_name || pair.streamer_b_username || pair.s2_username || "Streamer B");
                        const uA = escapeHtml(pair.streamer_a_username || pair.s1_username || "");
                        const uB = escapeHtml(pair.streamer_b_username || pair.s2_username || "");
                        const sharedCount = formatNumber(pair.shared_donors_count || 0);
                        const totalCoins = formatNumber(pair.total_shared_coins !== undefined ? pair.total_shared_coins : (pair.shared_volume_coins !== undefined ? pair.shared_volume_coins : 0));
                        const coinsA = formatNumber(pair.total_coins_a !== undefined ? pair.total_coins_a : 0);
                        const coinsB = formatNumber(pair.total_coins_b !== undefined ? pair.total_coins_b : 0);
                        const pctA = Math.round(pair.streamer_a_pct !== undefined ? pair.streamer_a_pct : 50);
                        const pctB = 100 - pctA;

                        const avatarA = (pair.streamer_a_avatar || pair.s1_avatar)
                            ? `<img src="${escapeHtml(pair.streamer_a_avatar || pair.s1_avatar)}" class="chat-avatar" style="width:24px;height:24px;min-width:24px;min-height:24px;max-width:24px;max-height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border-color);" alt="" onerror="this.style.display='none'" />`
                            : `<div class="chat-avatar" style="width:24px;height:24px;min-width:24px;min-height:24px;max-width:24px;max-height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">${uA.charAt(0).toUpperCase()}</div>`;
                        const avatarB = (pair.streamer_b_avatar || pair.s2_avatar)
                            ? `<img src="${escapeHtml(pair.streamer_b_avatar || pair.s2_avatar)}" class="chat-avatar" style="width:24px;height:24px;min-width:24px;min-height:24px;max-width:24px;max-height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border-color);" alt="" onerror="this.style.display='none'" />`
                            : `<div class="chat-avatar" style="width:24px;height:24px;min-width:24px;min-height:24px;max-width:24px;max-height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">${uB.charAt(0).toUpperCase()}</div>`;

                        const topDonorsList = pair.top_donors || pair.top_shared_donors || [];
                        let donorsHtml = "";
                        if (topDonorsList.length > 0) {
                            donorsHtml = `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:6px;">`;
                            topDonorsList.slice(0, 5).forEach(d => {
                                const du = escapeHtml(d.username);
                                const dn = escapeHtml(d.display_name || d.username);
                                const dc = formatNumber(d.total_coins || d.coins || 0);
                                donorsHtml += `
                                    <span class="crm-quick-tag" onclick="window.tokRadar.openDossier('${du}')" title="${du}: ${dc} Coins an beide Kanäle">
                                        ${dn} (${dc})
                                    </span>
                                `;
                            });
                            donorsHtml += `</div>`;
                        }

                        html += `
                            <tr>
                                <td>
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        <div style="display:flex; align-items:center; gap:4px;">
                                            ${avatarA}
                                            <span style="font-weight:700; color:var(--text-strong);">@${uA}</span>
                                        </div>
                                        <span class="mono muted" style="font-size:12px;">⟷</span>
                                        <div style="display:flex; align-items:center; gap:4px;">
                                            ${avatarB}
                                            <span style="font-weight:700; color:var(--text-strong);">@${uB}</span>
                                        </div>
                                    </div>
                                    ${donorsHtml}
                                </td>
                                <td style="text-align:right;">
                                    <span class="mono" style="font-weight:700; color:#fbbf24;">${sharedCount} Spender</span>
                                </td>
                                <td style="text-align:right;">
                                    <span class="mono" style="font-weight:800; color:#38bdf8; font-size:13px;">${totalCoins}</span>
                                </td>
                                <td style="text-align:right;">
                                    <div class="mono" style="font-size:11.5px; color:#d8b4fe;">${coinsA}</div>
                                    <div class="mono muted" style="font-size:10px;">${pctA}% Anteil</div>
                                </td>
                                <td style="text-align:right;">
                                    <div class="mono" style="font-size:11.5px; color:#38bdf8;">${coinsB}</div>
                                    <div class="mono muted" style="font-size:10px;">${pctB}% Anteil</div>
                                </td>
                                <td>
                                    <div style="min-width:140px;">
                                        <div style="display:flex; justify-content:space-between; font-size:10px; margin-bottom:3px;" class="mono muted">
                                            <span>@${uA} (${pctA}%)</span>
                                            <span>@${uB} (${pctB}%)</span>
                                        </div>
                                        <div style="height:7px; border-radius:4px; overflow:hidden; display:flex; background:var(--bg-surface); border:1px solid var(--border-subtle);">
                                            <div style="width:${pctA}%; background:#a855f7;" title="@${uA}: ${pctA}%"></div>
                                            <div style="width:${pctB}%; background:#0ea5e9;" title="@${uB}: ${pctB}%"></div>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        `;
                    });
                    overlapMatrixBody.innerHTML = html;
                }
            }
        } catch (err) {
            console.error("Fehler beim Abrufen der Loyalitätsdaten:", err);
            if (frontenwechslerTableBody) {
                frontenwechslerTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#f87171; padding:20px;">Fehler beim Laden der Frontenwechsler.</td></tr>`;
            }
            if (overlapMatrixBody) {
                overlapMatrixBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#f87171; padding:20px;">Fehler beim Laden der Überschneidungs-Matrix.</td></tr>`;
            }
        } finally {
            isFetchingLoyalty = false;
        }
    }

    // Polling Sync Loop
    function startSyncLoop() {
        stopSyncLoop();
        syncIntervalId = setInterval(() => {
            pollChatMessages();
            pollWhaleAlerts();
        }, 3000);
    }

    function stopSyncLoop() {
        if (syncIntervalId) {
            clearInterval(syncIntervalId);
            syncIntervalId = null;
        }
    }

    // Export globally for inline onclick
    window.tokRadar = {
        openDossier: openDossier,
        toggleVipQuick: toggleVipQuick,
        toggleModalVip: toggleModalVip,
        addModalTag: addModalTag,
        addCustomModalTag: addCustomModalTag,
        removeModalTag: removeModalTag,
        saveModalCrm: saveModalCrm,
    };

    // Initialize on DOM Ready
    document.addEventListener("DOMContentLoaded", () => {
        initEvents();
        loadDonorRadarData();
        pollChatMessages();
        pollWhaleAlerts();
        startSyncLoop();
    });

})();
