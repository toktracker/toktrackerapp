/* =====================================================================
   toktracker Telegram Mini-App Client Logic v2.2.0
   Mobile-First Real-Time Feed, Public Analytics & Admin Control Panel
   ===================================================================== */

(function () {
    "use strict";

    // 1. Telegram WebApp Integration
    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg) {
        try {
            tg.ready();
            tg.expand();
            if (tg.setHeaderColor) {
                tg.setHeaderColor("#0b0e14");
            }
            if (tg.setBackgroundColor) {
                tg.setBackgroundColor("#0b0e14");
            }
        } catch (e) {
            console.warn("Telegram WebApp init hint:", e);
        }
    }

    // State
    let currentPeriod = "24h";
    let activeTab = "tab-streamers";
    let pollInterval = null;
    let isFetching = false;
    let isAdmin = false;
    let isWhitelisted = false;
    let authUser = null;
    let sessionToken = localStorage.getItem("toktracker_admin_token") || "";
    let cachedStreamers = [];
    let selectedAnalyticsStreamer = "all";
    let analyticsMetric = "both";
    let analyticsChartType = "line";
    let cachedAnalyticsData = null;
    let analyticsLoadedOnce = false;
    let lastAnalyticsFingerprint = null;

    // Radar State
    let radarTier = "all";
    let radarCrossOnly = false;
    let radarVipOnly = false;
    let radarSearch = "";
    let radarSearchDebounceTimer = null;
    let radarLoadedOnce = false;
    let cachedRadarData = null;
    let radarSubTab = "donors";
    let whaleAlertMinCoins = 1000;
    let lastSeenWhaleAlertId = 0;
    let whaleSoundEnabled = false;
    let loyaltyDaysRecent = 14;
    let radarPollInterval = null;
    let currentDossierData = null;
    let audioCtx = null;

    // Chart.js Instances
    let chartTimelineInstance = null;
    let chartStreamerCompareInstance = null;
    let chartGiftDistInstance = null;
    let chartTimeOfDayInstance = null;

    // Cache DOM Elements
    const elements = {
        btnRefresh: document.getElementById("maBtnRefresh"),
        periodPills: document.querySelectorAll(".period-pill"),
        navTabs: document.querySelectorAll(".nav-tab-btn"),
        tabViews: document.querySelectorAll(".ma-tab-view"),
        headerAdminBadge: document.getElementById("maHeaderAdminBadge"),

        // KPIs
        kpiNetEur: document.getElementById("kpiNetEur"),
        kpiNetUsd: document.getElementById("kpiNetUsd"),
        kpiCoins: document.getElementById("kpiCoins"),
        kpiGifts: document.getElementById("kpiGifts"),
        kpiLiveCount: document.getElementById("kpiLiveCount"),
        liveBanner: document.getElementById("maLiveBanner"),
        liveBannerText: document.getElementById("maLiveBannerText"),

        // Containers
        liveBattlesContainer: document.getElementById("maLiveBattlesContainer"),
        recentBattlesContainer: document.getElementById("maRecentBattlesContainer"),
        streamersContainer: document.getElementById("maStreamersContainer"),
        giftsContainer: document.getElementById("maGiftsContainer"),

        // Analytics Elements
        analyticsStreamerSelect: document.getElementById("maAnalyticsStreamerSelect"),
        kpiUniqueGifters: document.getElementById("maKpiUniqueGifters"),
        kpiAvgPerGifter: document.getElementById("maKpiAvgPerGifter"),
        kpiAvgCoinsGift: document.getElementById("maKpiAvgCoinsGift"),
        kpiWhaleShare: document.getElementById("maKpiWhaleShare"),
        kpiGrossRevenue: document.getElementById("maKpiGrossRevenue"),
        kpiNetQuote: document.getElementById("maKpiNetQuote"),
        kpiTotalEvents: document.getElementById("maKpiTotalEvents"),
        kpiCadence: document.getElementById("maKpiCadence"),
        metricSelect: document.getElementById("maTimelineMetricSelect"),
        metricPills: document.querySelectorAll(".ma-metric-pill"),
        timelineTitle: document.getElementById("maTimelineTitle"),
        timelineSub: document.getElementById("maTimelineSub"),
        btnChartLine: document.getElementById("maBtnChartLine"),
        btnChartBar: document.getElementById("maBtnChartBar"),
        btnChartArea: document.getElementById("maBtnChartArea"),
        statPeak: document.getElementById("maStatPeak"),
        statAvg: document.getElementById("maStatAvg"),
        statTotal: document.getElementById("maStatTotal"),
        chartTimeline: document.getElementById("maChartTimeline"),
        chartStreamerCompare: document.getElementById("maChartStreamerCompare"),
        topGiftersContainer: document.getElementById("maTopGiftersContainer"),
        chartGiftDist: document.getElementById("maChartGiftDist"),
        topGiftsList: document.getElementById("maTopGiftsList"),
        chartTimeOfDay: document.getElementById("maChartTimeOfDay"),

        // Admin Elements
        adminAuthGate: document.getElementById("maAdminAuthGate"),
        adminContent: document.getElementById("maAdminContent"),
        authGateMsg: document.getElementById("maAuthGateMsg"),
        otpCodeInput: document.getElementById("maOtpCodeInput"),
        btnSubmitOtp: document.getElementById("maBtnSubmitOtp"),
        btnRequestOtp: document.getElementById("maBtnRequestOtp"),
        adminUserLabel: document.getElementById("maAdminUserLabel"),
        btnAdminLogout: document.getElementById("maBtnAdminLogout"),
        adminStreamersContainer: document.getElementById("maAdminStreamersContainer"),

        // Admin Diagnostic Elements
        diagDbEngine: document.getElementById("maDiagDbEngine"),
        diagActiveWorkers: document.getElementById("maDiagActiveWorkers"),
        diagBotStatus: document.getElementById("maDiagBotStatus"),
        diagTiktokSession: document.getElementById("maDiagTiktokSession"),
        btnMaRefreshHealth: document.getElementById("btnMaRefreshHealth"),
        healthStatusBadge: document.getElementById("maHealthStatusBadge"),
        healthDiskPercent: document.getElementById("maHealthDiskPercent"),
        healthDiskBar: document.getElementById("maHealthDiskBar"),
        healthDiskUsed: document.getElementById("maHealthDiskUsed"),
        healthDiskFree: document.getElementById("maHealthDiskFree"),
        healthDiskTotal: document.getElementById("maHealthDiskTotal"),
        healthRamPercent: document.getElementById("maHealthRamPercent"),
        healthRamBar: document.getElementById("maHealthRamBar"),
        healthRamUsed: document.getElementById("maHealthRamUsed"),
        healthRamFree: document.getElementById("maHealthRamFree"),
        healthRamTotal: document.getElementById("maHealthRamTotal"),
        healthCpuPercent: document.getElementById("maHealthCpuPercent"),
        healthCpuBar: document.getElementById("maHealthCpuBar"),
        healthCpuLoad: document.getElementById("maHealthCpuLoad"),
        healthCpuCores: document.getElementById("maHealthCpuCores"),
        dockerConnBadge: document.getElementById("maDockerConnBadge"),
        containersList: document.getElementById("maContainersList"),
        volumesSummary: document.getElementById("maVolumesSummary"),
        dbSummary: document.getElementById("maDbSummary"),

        // Admin Action Buttons
        btnOpenAddStreamer: document.getElementById("maBtnOpenAddStreamer"),
        btnOpenAddGift: document.getElementById("maBtnOpenAddGift"),
        btnOpenSettings: document.getElementById("maBtnOpenSettings"),
        btnOpenWhitelist: document.getElementById("maBtnOpenWhitelist"),

        // Modals
        modalAddStreamer: document.getElementById("modalAddStreamer"),
        modalAddGift: document.getElementById("modalAddGift"),
        modalSettings: document.getElementById("modalSettings"),
        modalWhitelist: document.getElementById("modalWhitelist"),

        // Modal Form Controls
        inputAddStreamerUsername: document.getElementById("inputAddStreamerUsername"),
        inputAddStreamerDisplayName: document.getElementById("inputAddStreamerDisplayName"),
        checkAddStreamerAutoTrack: document.getElementById("checkAddStreamerAutoTrack"),
        checkAddStreamerAutoReconnect: document.getElementById("checkAddStreamerAutoReconnect"),
        btnSubmitAddStreamer: document.getElementById("btnSubmitAddStreamer"),

        selectAddGiftStreamer: document.getElementById("selectAddGiftStreamer"),
        inputAddGiftName: document.getElementById("inputAddGiftName"),
        inputAddGiftCoins: document.getElementById("inputAddGiftCoins"),
        inputAddGiftCount: document.getElementById("inputAddGiftCount"),
        inputAddGiftSender: document.getElementById("inputAddGiftSender"),
        btnSubmitAddGift: document.getElementById("btnSubmitAddGift"),

        inputSettingsUsdDiamond: document.getElementById("inputSettingsUsdDiamond"),
        inputSettingsGrossCoin: document.getElementById("inputSettingsGrossCoin"),
        inputSettingsUsdToEur: document.getElementById("inputSettingsUsdToEur"),
        selectSettingsCurrency: document.getElementById("selectSettingsCurrency"),
        selectSettingsTgMode: document.getElementById("selectSettingsTgMode"),
        btnSubmitSettings: document.getElementById("btnSubmitSettings"),

        inputAddTgUserIdent: document.getElementById("inputAddTgUserIdent"),
        selectAddTgUserRole: document.getElementById("selectAddTgUserRole"),
        btnSubmitAddTgUser: document.getElementById("btnSubmitAddTgUser"),
        whitelistUsersContainer: document.getElementById("maWhitelistUsersContainer"),

        // Radar Elements
        radarTotalBadge: document.getElementById("maRadarTotalBadge"),
        radarAuthGate: document.getElementById("maRadarAuthGate"),
        radarAuthGateMsg: document.getElementById("maRadarAuthGateMsg"),
        radarContent: document.getElementById("maRadarContent"),
        radarKpiWhales: document.getElementById("maRadarKpiWhales"),
        radarKpiSharks: document.getElementById("maRadarKpiSharks"),
        radarKpiDolphins: document.getElementById("maRadarKpiDolphins"),
        radarKpiCross: document.getElementById("maRadarKpiCross"),
        radarKpiVip: document.getElementById("maRadarKpiVip"),
        cardKpiVip: document.getElementById("maCardKpiVip"),
        radarSearchInput: document.getElementById("maRadarSearchInput"),
        radarSearchClear: document.getElementById("maRadarSearchClear"),
        radarTierPills: document.querySelectorAll(".ma-tier-pill"),
        btnToggleCrossOnly: document.getElementById("maBtnToggleCrossOnly"),
        btnToggleVipOnly: document.getElementById("maBtnToggleVipOnly"),
        radarDonorsContainer: document.getElementById("maRadarDonorsContainer"),
        whaleTickerBar: document.getElementById("maWhaleTickerBar"),
        whaleTickerTrack: document.getElementById("maWhaleTickerTrack"),
        btnToggleWhaleSound: document.getElementById("maBtnToggleWhaleSound"),
        whaleSoundIcon: document.getElementById("maWhaleSoundIcon"),
        whaleAlertCountBadge: document.getElementById("maWhaleAlertCountBadge"),
        subTabDonors: document.getElementById("maSubTabDonors"),
        subTabAlerts: document.getElementById("maSubTabAlerts"),
        subTabLoyalty: document.getElementById("maSubTabLoyalty"),
        subViewDonors: document.getElementById("maSubViewDonors"),
        subViewAlerts: document.getElementById("maSubViewAlerts"),
        subViewLoyalty: document.getElementById("maSubViewLoyalty"),
        whaleAlertsContainer: document.getElementById("maWhaleAlertsContainer"),
        btnRefreshWhaleAlerts: document.getElementById("maBtnRefreshWhaleAlerts"),
        alertThresholdPills: document.querySelectorAll(".ma-alert-pill"),
        frontenwechslerBadge: document.getElementById("maFrontenwechslerBadge"),
        frontenwechslerContainer: document.getElementById("maFrontenwechslerContainer"),
        overlapPairsBadge: document.getElementById("maOverlapPairsBadge"),
        overlapMatrixContainer: document.getElementById("maOverlapMatrixContainer"),
        btnRefreshLoyalty: document.getElementById("maBtnRefreshLoyalty"),
        loyaltyDaysPills: document.querySelectorAll(".ma-loyalty-pill"),
        modalDonorDossier: document.getElementById("modalDonorDossier"),
        dossierUsername: document.getElementById("maDossierUsername"),
        dossierTierBadge: document.getElementById("maDossierTierBadge"),
        dossierBody: document.getElementById("maDossierBody"),

        toastContainer: document.getElementById("maToastContainer"),
    };

    // Formatters
    function formatNumber(num) {
        return new Intl.NumberFormat("de-DE").format(Math.round(num || 0));
    }

    function formatCurrency(val, currency = "EUR") {
        return new Intl.NumberFormat("de-DE", {
            style: "currency",
            currency: currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(val || 0);
    }

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function getRelativeTime(timestamp) {
        if (!timestamp) return "";
        try {
            const date = new Date(timestamp);
            const now = new Date();
            const diffSec = Math.floor((now - date) / 1000);
            if (diffSec < 60) return "gerade eben";
            if (diffSec < 3600) return `vor ${Math.floor(diffSec / 60)}m`;
            if (diffSec < 86400) return `vor ${Math.floor(diffSec / 3600)}h`;
            return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
        } catch (e) {
            return timestamp;
        }
    }

    function triggerHaptic(type = "light") {
        if (tg && tg.HapticFeedback) {
            try {
                if (type === "light" || type === "medium" || type === "heavy") {
                    tg.HapticFeedback.impactOccurred(type);
                } else if (type === "success" || type === "error" || type === "warning") {
                    tg.HapticFeedback.notificationOccurred(type);
                }
            } catch (e) {}
        }
    }

    function showToast(msg, type = "success") {
        if (!elements.toastContainer) return;
        const toast = document.createElement("div");
        toast.className = `ma-toast ${type}`;
        toast.textContent = msg;
        elements.toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transform = "translateY(12px)";
            setTimeout(() => toast.remove(), 200);
        }, 3200);
    }

    function openModal(el) {
        if (!el) return;
        triggerHaptic("light");
        el.classList.add("open");
    }

    function closeModal(el) {
        if (!el) return;
        triggerHaptic("light");
        el.classList.remove("open");
    }

    function getAuthHeaders() {
        const headers = { "Accept": "application/json" };
        if (sessionToken) {
            headers["X-Admin-Session"] = sessionToken;
        }
        return headers;
    }

    // =====================================================================
    // 2. AUTHENTICATION & SESSION MANAGEMENT
    // =====================================================================
    async function initAuth() {
        // Step A: Telegram Native WebApp initData
        if (tg && tg.initData) {
            try {
                const res = await fetch("/api/miniapp/auth", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Accept": "application/json" },
                    body: JSON.stringify({ init_data: tg.initData })
                });
                if (res.ok) {
                    const data = await res.json();
                    isAdmin = !!data.is_admin;
                    isWhitelisted = !!data.is_whitelisted || isAdmin;
                    authUser = data.user;
                    if (data.token) {
                        sessionToken = data.token;
                        localStorage.setItem("toktracker_admin_token", sessionToken);
                    }
                    updateAdminUI();
                    updateRadarAuthUI();
                    return;
                }
            } catch (err) {
                console.warn("Telegram WebApp Auth Fehler:", err);
            }
        }

        // Step B: Check stored session token / cookie status
        try {
            const res = await fetch("/api/miniapp/auth/status", {
                headers: getAuthHeaders()
            });
            if (res.ok) {
                const data = await res.json();
                isAdmin = !!data.is_admin;
                isWhitelisted = !!data.is_whitelisted || isAdmin;
                authUser = { username: data.admin_label || "Admin" };
            } else {
                isAdmin = false;
                isWhitelisted = false;
            }
        } catch (e) {
            isAdmin = false;
            isWhitelisted = false;
        }
        updateAdminUI();
        updateRadarAuthUI();
    }

    function updateAdminUI() {
        if (elements.headerAdminBadge) {
            elements.headerAdminBadge.style.display = isAdmin ? "inline-block" : "none";
        }

        if (isAdmin) {
            if (elements.adminAuthGate) elements.adminAuthGate.style.display = "none";
            if (elements.adminContent) elements.adminContent.style.display = "block";
            if (elements.adminUserLabel) {
                const name = authUser && (authUser.username ? `@${authUser.username}` : (authUser.first_name || authUser.id)) || "Admin";
                elements.adminUserLabel.textContent = name;
            }
            if (activeTab === "tab-admin") {
                loadAdminData();
            }
        } else {
            if (elements.adminAuthGate) elements.adminAuthGate.style.display = "block";
            if (elements.adminContent) elements.adminContent.style.display = "none";
            if (elements.authGateMsg) {
                if (authUser && authUser.username) {
                    elements.authGateMsg.textContent = `Angemeldet als @${authUser.username} (Zuschauer-Rolle ohne Admin-Rechte).`;
                } else {
                    elements.authGateMsg.textContent = "Dieser Bereich erfordert Administrator-Rechte.";
                }
            }
        }
    }

    function updateRadarAuthUI() {
        if (!elements.radarAuthGate || !elements.radarContent) return;
        if (isWhitelisted || isAdmin) {
            elements.radarAuthGate.style.display = "none";
            elements.radarContent.style.display = "block";
        } else {
            elements.radarAuthGate.style.display = "block";
            elements.radarContent.style.display = "none";
        }
    }

    // =====================================================================
    // 3. DATA FETCHING (FEED & OVERVIEW)
    // =====================================================================
    async function fetchMiniAppData() {
        if (isFetching) return;
        isFetching = true;
        if (elements.btnRefresh) elements.btnRefresh.classList.add("spinning");

        try {
            const res = await fetch(`/api/miniapp/data?period=${encodeURIComponent(currentPeriod)}`, {
                headers: getAuthHeaders()
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            renderMiniApp(data);
        } catch (err) {
            console.error("Mini-App Fetch Fehler:", err);
        } finally {
            isFetching = false;
            if (elements.btnRefresh) elements.btnRefresh.classList.remove("spinning");
        }
    }

    function renderMiniApp(data) {
        const totals = data.totals || {};
        const streamers = data.streamers || [];
        cachedStreamers = streamers;
        const liveBattles = data.live_battles || [];
        const recentBattles = data.recent_battles || [];
        const recentGifts = data.recent_gifts || [];

        // 1. KPIs
        const netEur = totals.eur_net !== undefined ? totals.eur_net : (totals.total_eur_net || 0);
        const netUsd = totals.usd_net !== undefined ? totals.usd_net : (totals.total_usd_net || 0);
        if (elements.kpiNetEur) elements.kpiNetEur.textContent = formatCurrency(netEur, "EUR");
        if (elements.kpiNetUsd) elements.kpiNetUsd.textContent = `$${formatNumber(netUsd)} USD`;
        if (elements.kpiCoins) elements.kpiCoins.textContent = formatNumber(totals.total_coins);
        if (elements.kpiGifts) elements.kpiGifts.textContent = formatNumber(totals.total_gifts_sent || totals.gift_events_count);

        const liveCount = streamers.filter(s => s.is_live).length;
        if (elements.kpiLiveCount) elements.kpiLiveCount.textContent = `${liveCount} LIVE`;

        // 2. Live Banner Status
        if (elements.liveBanner && elements.liveBannerText) {
            if (liveCount > 0) {
                elements.liveBanner.className = "ma-live-banner";
                elements.liveBannerText.textContent = `🟢 ${liveCount} Streamer aktiv LIVE auf Sendung`;
            } else {
                elements.liveBanner.className = "ma-live-banner no-active";
                elements.liveBannerText.textContent = `💤 Aktuell keine Streamer LIVE – Auto-Monitor aktiv`;
            }
        }

        // 3. Render Views
        renderLiveBattles(liveBattles);
        renderRecentBattles(recentBattles);
        renderStreamers(streamers);
        renderGifts(recentGifts);
        populateStreamerSelects(streamers);

        // Update active tab data if needed
        if (activeTab === "tab-analytics") {
            if (analyticsLoadedOnce) {
                fetchAnalyticsData(true);
            }
        } else if (activeTab === "tab-admin" && isAdmin) {
            renderAdminStreamers(streamers);
        }
    }

    function renderLiveBattles(liveBattles) {
        if (!elements.liveBattlesContainer) return;
        if (!liveBattles || liveBattles.length === 0) {
            elements.liveBattlesContainer.innerHTML = "";
            return;
        }

        let html = '<div class="section-head"><div class="section-title">🔴 LIVE DUELL</div></div>';
        liveBattles.forEach(item => {
            const b = item.battle || {};
            const isInternal = Boolean(b.is_internal);

            if (isInternal) {
                const sA = b.streamer_a || {};
                const sB = b.streamer_b || {};
                const sScore = sA.score || b.streamer_score || 0;
                const oScore = sB.score || b.opponent_score || 0;
                const totalScore = Math.max(1, sScore + oScore);
                const sPct = Math.round((sScore / totalScore) * 100);
                const oPct = 100 - sPct;

                html += `
                    <div class="battle-card-mobile active-match card-derby">
                        <div class="battle-card-header">
                            <span class="match-mode-pill mode-derby">⚔️ DERBY</span>
                            <span class="match-result-badge live">LIVE DERBY</span>
                        </div>

                        <div class="battle-arena-1v1">
                            <div class="combatant-side">
                                <div class="combatant-avatar-wrap">
                                    <img src="${escapeHtml(sA.avatar_url || '/static/avatar_default.png')}" class="combatant-avatar ${sScore >= oScore ? 'winner-glow' : ''}" onerror="this.src='/static/avatar_default.png'">
                                </div>
                                <div class="combatant-name">${escapeHtml(sA.display_name || sA.username || '')}</div>
                                <div class="combatant-score" style="color: #38bdf8;">${formatNumber(sScore)}</div>
                                <div style="font-size: 10px; color: #10b981; font-weight: 700; margin-top: 2px;">+${formatCurrency(sA.eur_net || 0)}</div>
                            </div>

                            <div class="vs-center-mobile"><span class="vs-text" style="color:#8b5cf6;">VS</span></div>

                            <div class="combatant-side">
                                <div class="combatant-avatar-wrap">
                                    <img src="${escapeHtml(sB.avatar_url || '/static/avatar_default.png')}" class="combatant-avatar ${oScore >= sScore ? 'winner-glow' : ''}" onerror="this.src='/static/avatar_default.png'">
                                </div>
                                <div class="combatant-name">${escapeHtml(sB.display_name || sB.username || '')}</div>
                                <div class="combatant-score" style="color: #ec4899;">${formatNumber(oScore)}</div>
                                <div style="font-size: 10px; color: #10b981; font-weight: 700; margin-top: 2px;">+${formatCurrency(sB.eur_net || 0)}</div>
                            </div>
                        </div>

                        <div class="duel-score-bar-mobile">
                            <div class="bar-side-left" style="width: ${sPct}%; background: #38bdf8;"></div>
                            <div class="bar-side-right" style="width: ${oPct}%; background: #ec4899;"></div>
                        </div>

                        <div class="battle-card-footer">
                            <span>Vorsprung: ${formatNumber(Math.abs(sScore - oScore))} Pkt</span>
                            <span class="battle-earnings-badge" style="background: rgba(139, 92, 246, 0.2); color: #c084fc; border: 1px solid #8b5cf6;">🔥 +${formatCurrency(b.total_eur_net || b.eur_net || 0, "EUR")}</span>
                        </div>
                    </div>
                `;
                return;
            }

            const mode = b.battle_mode || "1v1";
            const sName = item.display_name || item.username;
            const sAvatar = item.avatar_url || "/static/avatar_default.png";
            const oName = b.opponent_display_name || b.opponent_username || "Gegner";
            const oAvatar = b.opponent_avatar_url || "/static/avatar_default.png";

            const sScore = b.streamer_score || 0;
            const oScore = b.opponent_score || 0;
            const totalScore = Math.max(1, sScore + oScore);
            const sPct = Math.round((sScore / totalScore) * 100);
            const oPct = 100 - sPct;

            html += `
                <div class="battle-card-mobile active-match">
                    <div class="battle-card-header">
                        <span class="match-mode-pill mode-${escapeHtml(mode)}">${escapeHtml(mode.toUpperCase())}</span>
                        <span class="match-result-badge live">LIVE DUELL</span>
                    </div>

                    <div class="battle-arena-1v1">
                        <div class="combatant-side">
                            <div class="combatant-avatar-wrap">
                                <img src="${escapeHtml(sAvatar)}" class="combatant-avatar ${sScore >= oScore ? 'winner-glow' : ''}" onerror="this.src='/static/avatar_default.png'">
                            </div>
                            <div class="combatant-name">${escapeHtml(sName)}</div>
                            <div class="combatant-score" style="color: #38bdf8;">${formatNumber(sScore)}</div>
                        </div>

                        <div class="vs-center-mobile"><span class="vs-text">VS</span></div>

                        <div class="combatant-side">
                            <div class="combatant-avatar-wrap">
                                <img src="${escapeHtml(oAvatar)}" class="combatant-avatar ${oScore >= sScore ? 'winner-glow' : ''}" onerror="this.src='/static/avatar_default.png'">
                            </div>
                            <div class="combatant-name">${escapeHtml(oName)}</div>
                            <div class="combatant-score" style="color: #ef4444;">${formatNumber(oScore)}</div>
                        </div>
                    </div>

                    <div class="duel-score-bar-mobile">
                        <div class="bar-side-left" style="width: ${sPct}%;"></div>
                        <div class="bar-side-right" style="width: ${oPct}%;"></div>
                    </div>

                    <div class="battle-card-footer">
                        <span>Punkte-Vorsprung: ${formatNumber(Math.abs(sScore - oScore))}</span>
                        <span class="battle-earnings-badge">LIVE BATTLE</span>
                    </div>
                </div>
            `;
        });
        elements.liveBattlesContainer.innerHTML = html;
    }

    function renderRecentBattles(battles) {
        if (!elements.recentBattlesContainer) return;
        if (!battles || battles.length === 0) {
            elements.recentBattlesContainer.innerHTML = `
                <div class="ma-empty-state">
                    <div class="ma-empty-icon">⚔️</div>
                    <div>Noch keine Matches im gewählten Zeitraum erfasst.</div>
                </div>
            `;
            return;
        }

        let html = "";
        battles.forEach(b => {
            const isInternal = Boolean(b.is_internal);

            if (isInternal) {
                const sA = b.streamer_a || {};
                const sB = b.streamer_b || {};
                const sScore = sA.score || b.streamer_score || 0;
                const oScore = sB.score || b.opponent_score || 0;
                const totalScore = Math.max(1, sScore + oScore);
                const sPct = Math.round((sScore / totalScore) * 100);
                const oPct = 100 - sPct;

                const relTime = getRelativeTime(b.started_at || b.created_at);
                const winnerLabel = b.winner_username ? `🏆 @${escapeHtml(b.winner_username)}` : "🤝 REMIS";

                html += `
                    <div class="battle-card-mobile card-derby">
                        <div class="battle-card-header">
                            <span class="match-mode-pill mode-derby">⚔️ INTERNES DERBY</span>
                            <span class="match-result-badge win">${winnerLabel}</span>
                        </div>

                        <div class="battle-arena-1v1">
                            <div class="combatant-side">
                                <div class="combatant-avatar-wrap">
                                    <img src="${escapeHtml(sA.avatar_url || '/static/avatar_default.png')}" class="combatant-avatar ${b.winner_username === sA.username ? 'winner-glow' : ''}" onerror="this.src='/static/avatar_default.png'">
                                </div>
                                <div class="combatant-name">${escapeHtml(sA.display_name || sA.username || '')}</div>
                                <div class="combatant-score" style="color: #38bdf8;">${formatNumber(sScore)}</div>
                                <div style="font-size: 10px; color: #10b981; font-weight: 700; margin-top: 2px;">+${formatCurrency(sA.eur_net || 0)}</div>
                            </div>

                            <div class="vs-center-mobile"><span class="vs-text" style="color:#8b5cf6;">VS</span></div>

                            <div class="combatant-side">
                                <div class="combatant-avatar-wrap">
                                    <img src="${escapeHtml(sB.avatar_url || '/static/avatar_default.png')}" class="combatant-avatar ${b.winner_username === sB.username ? 'winner-glow' : ''}" onerror="this.src='/static/avatar_default.png'">
                                </div>
                                <div class="combatant-name">${escapeHtml(sB.display_name || sB.username || '')}</div>
                                <div class="combatant-score" style="color: #ec4899;">${formatNumber(oScore)}</div>
                                <div style="font-size: 10px; color: #10b981; font-weight: 700; margin-top: 2px;">+${formatCurrency(sB.eur_net || 0)}</div>
                            </div>
                        </div>

                        <div class="duel-score-bar-mobile">
                            <div class="bar-side-left" style="width: ${sPct}%; background: #38bdf8;"></div>
                            <div class="bar-side-right" style="width: ${oPct}%; background: #ec4899;"></div>
                        </div>

                        <div class="battle-card-footer">
                            <span>${relTime} · ${formatNumber(b.total_coins || b.coins_earned || 0)} Coins</span>
                            <span class="battle-earnings-badge" style="background: rgba(139, 92, 246, 0.2); color: #c084fc; border: 1px solid #8b5cf6;">🔥 +${formatCurrency(b.total_eur_net || b.eur_net || 0, "EUR")}</span>
                        </div>
                    </div>
                `;
                return;
            }

            const mode = b.battle_mode || "1v1";
            const res = (b.result || "DRAW").toUpperCase();
            const resClass = res === "WIN" ? "win" : (res === "LOSE" ? "lose" : "draw");
            const resLabel = res === "WIN" ? "SIEG" : (res === "LOSE" ? "NIEDERLAGE" : "UNENTSCHIEDEN");

            const sName = b.streamer_display_name || b.streamer_username || "Streamer";
            const sAvatar = b.streamer_avatar_url || "/static/avatar_default.png";
            const sScore = b.streamer_score || 0;
            const relTime = getRelativeTime(b.started_at || b.created_at);

            const oName = b.opponent_display_name || b.opponent_username || "Gegner";
            const oAvatar = b.opponent_avatar_url || "/static/avatar_default.png";
            const oScore = b.opponent_score || 0;

            const totalScore = Math.max(1, sScore + oScore);
            const sPct = Math.round((sScore / totalScore) * 100);
            const oPct = 100 - sPct;

            html += `
                <div class="battle-card-mobile">
                    <div class="battle-card-header">
                        <span class="match-mode-pill mode-${escapeHtml(mode)}">${escapeHtml(mode.toUpperCase())}</span>
                        <span class="match-result-badge ${resClass}">${resLabel}</span>
                    </div>

                    <div class="battle-arena-1v1">
                        <div class="combatant-side">
                            <div class="combatant-avatar-wrap">
                                <img src="${escapeHtml(sAvatar)}" class="combatant-avatar ${res === 'WIN' ? 'winner-glow' : ''}" onerror="this.src='/static/avatar_default.png'">
                            </div>
                            <div class="combatant-name">${escapeHtml(sName)}</div>
                            <div class="combatant-score" style="color: #38bdf8;">${formatNumber(sScore)}</div>
                        </div>

                        <div class="vs-center-mobile"><span class="vs-text">VS</span></div>

                        <div class="combatant-side">
                            <div class="combatant-avatar-wrap">
                                <img src="${escapeHtml(oAvatar)}" class="combatant-avatar ${res === 'LOSE' ? 'winner-glow' : ''}" onerror="this.src='/static/avatar_default.png'">
                            </div>
                            <div class="combatant-name">${escapeHtml(oName)}</div>
                            <div class="combatant-score" style="color: #ef4444;">${formatNumber(oScore)}</div>
                        </div>
                    </div>

                    <div class="duel-score-bar-mobile">
                        <div class="bar-side-left" style="width: ${sPct}%;"></div>
                        <div class="bar-side-right" style="width: ${oPct}%;"></div>
                    </div>

                    <div class="battle-card-footer">
                        <span>${relTime} · ${formatNumber(b.coins_earned || 0)} Coins</span>
                        <span class="battle-earnings-badge">+${formatCurrency(b.eur_net, "EUR")}</span>
                    </div>
                </div>
            `;
        });
        elements.recentBattlesContainer.innerHTML = html;
    }

    function renderStreamers(streamers) {
        if (!elements.streamersContainer) return;
        if (!streamers || streamers.length === 0) {
            elements.streamersContainer.innerHTML = `
                <div class="ma-empty-state">
                    <div class="ma-empty-icon">👥</div>
                    <div>Keine Streamer im TokTracker hinterlegt.</div>
                </div>
            `;
            return;
        }

        let html = "";
        streamers.forEach(s => {
            const avatar = s.avatar_url || "/static/avatar_default.png";
            const name = s.display_name || s.username;
            const viewers = s.is_live ? `${formatNumber(s.current_viewers)} Zuschauer` : "Offline";

            html += `
                <div class="streamer-card-mobile ${s.is_live ? 'is-live' : ''}">
                    <div class="streamer-info-left">
                        <div class="streamer-avatar-box">
                            <img src="${escapeHtml(avatar)}" class="streamer-avatar-ma" onerror="this.src='/static/avatar_default.png'">
                            ${s.is_live ? '<span class="streamer-live-dot"></span>' : ''}
                        </div>
                        <div class="streamer-text-col">
                            <div class="streamer-title">${escapeHtml(name)}</div>
                            <div class="streamer-subtitle">@${escapeHtml(s.username)} · ${viewers}</div>
                        </div>
                    </div>

                    <div class="streamer-financials-right">
                        <div class="streamer-eur-net">${formatCurrency(s.eur_net, "EUR")}</div>
                        <div class="streamer-coins">${formatNumber(s.total_coins)} Coins</div>
                    </div>
                </div>
            `;
        });
        elements.streamersContainer.innerHTML = html;
    }

    function renderGifts(gifts) {
        if (!elements.giftsContainer) return;
        if (!gifts || gifts.length === 0) {
            elements.giftsContainer.innerHTML = `
                <div class="ma-empty-state">
                    <div class="ma-empty-icon">🎁</div>
                    <div>Keine Geschenke im ausgewählten Zeitraum erfasst.</div>
                </div>
            `;
            return;
        }

        let html = "";
        gifts.forEach(g => {
            const relTime = getRelativeTime(g.created_at);
            const count = g.repeat_count > 1 ? `${g.repeat_count}x ` : "";

            html += `
                <div class="gift-item-mobile">
                    <div class="gift-sender-info">
                        <div class="gift-icon-placeholder">🎁</div>
                        <div class="gift-text-wrap">
                            <div class="gift-sender-name">${escapeHtml(g.sender_username || 'Anonym')}</div>
                            <div class="gift-target-streamer">${count}${escapeHtml(g.gift_name)} → @${escapeHtml(g.streamer_username)} · ${relTime}</div>
                        </div>
                    </div>
                    <div class="gift-coins-val">+${formatNumber(g.total_coins)} Coins</div>
                </div>
            `;
        });
        elements.giftsContainer.innerHTML = html;
    }

    function populateStreamerSelects(streamers) {
        if (elements.analyticsStreamerSelect) {
            const currentVal = elements.analyticsStreamerSelect.value;
            let optHtml = '<option value="all">Alle Streamer</option>';
            streamers.forEach(s => {
                optHtml += `<option value="${s.id}">@${escapeHtml(s.username)}</option>`;
            });
            elements.analyticsStreamerSelect.innerHTML = optHtml;
            if (currentVal) elements.analyticsStreamerSelect.value = currentVal;
        }

        if (elements.selectAddGiftStreamer) {
            let optHtml = "";
            streamers.forEach(s => {
                optHtml += `<option value="${s.id}">@${escapeHtml(s.username)} (${escapeHtml(s.display_name)})</option>`;
            });
            elements.selectAddGiftStreamer.innerHTML = optHtml;
        }
    }

    // =====================================================================
    // 4. PUBLIC ANALYTICS & CHARTS
    // =====================================================================
    function updateAnalyticsTimestamp() {
        const el = document.getElementById("maAnalyticsTimestamp");
        if (el) {
            const d = new Date();
            const timeStr = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            el.textContent = `Stand: ${timeStr}`;
        }
    }

    async function fetchAnalyticsData(isBackground = false) {
        try {
            const sid = selectedAnalyticsStreamer !== "all" ? `&streamer_id=${encodeURIComponent(selectedAnalyticsStreamer)}` : "";
            const res = await fetch(`/api/miniapp/analytics?period=${encodeURIComponent(currentPeriod)}${sid}`, {
                headers: { "Accept": "application/json" }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            renderAnalytics(data, isBackground);
        } catch (err) {
            console.error("Analytics Fetch Fehler:", err);
        }
    }

    function renderAnalytics(data, isBackground = false) {
        if (typeof Chart === "undefined") {
            console.warn("Chart.js noch nicht geladen");
            return;
        }

        const totals = data.totals || {};
        const fingerprint = `${totals.total_coins}_${totals.gift_events_count}_${totals.unique_gifters}_${(data.timeline || []).length}_${currentPeriod}_${selectedAnalyticsStreamer}_${analyticsMetric}_${analyticsChartType}`;
        if (isBackground && lastAnalyticsFingerprint === fingerprint) {
            updateAnalyticsTimestamp();
            return;
        }
        lastAnalyticsFingerprint = fingerprint;

        cachedAnalyticsData = data;
        updateAnalyticsTimestamp();

        // 1. Render Mini KPIs (4-Card 2x2 Grid)
        if (elements.kpiUniqueGifters) elements.kpiUniqueGifters.textContent = formatNumber(totals.unique_gifters || 0);
        if (elements.kpiAvgPerGifter) elements.kpiAvgPerGifter.textContent = `Ø ${formatCurrency(totals.avg_eur_per_gifter)} / Spender`;
        if (elements.kpiAvgCoinsGift) elements.kpiAvgCoinsGift.textContent = `${formatNumber(totals.avg_coins_per_gift)} Coins`;
        if (elements.kpiWhaleShare) elements.kpiWhaleShare.textContent = `Top 5: ${totals.whale_share_top5_pct || 0}% Anteil`;
        if (elements.kpiGrossRevenue) elements.kpiGrossRevenue.textContent = formatCurrency(totals.eur_gross || 0);
        if (elements.kpiNetQuote) {
            const netQuote = (totals.eur_gross && totals.eur_gross > 0)
                ? (Math.round((totals.eur_net / totals.eur_gross) * 1000) / 10)
                : 0;
            elements.kpiNetQuote.textContent = `Netto-Quote: ${netQuote}%`;
        }
        if (elements.kpiTotalEvents) elements.kpiTotalEvents.textContent = formatNumber(totals.gift_events_count || 0);
        if (elements.kpiCadence) elements.kpiCadence.textContent = `${formatNumber(totals.total_gifts_sent || 0)} Geschenke gesamt`;

        // 2. Timeline Chart (Multi-Metric Deep-Dive)
        renderTimelineChart();

        // 3. Streamer Revenue Comparison
        renderStreamerCompareChart(data.streamers_ranking || []);

        // 4. Top Gifters Leaderboard
        renderTopGifters(data.top_gifters || []);

        // 5. Top Gifts Distribution
        renderGiftDistChart(data.top_gifts || []);

        // 6. Time of Day Pattern
        renderTimeOfDayChart(data.time_of_day || []);
    }

    function createChartGradient(ctx, hexColor) {
        try {
            const gradient = ctx.createLinearGradient(0, 0, 0, 240);
            let r = 56, g = 189, b = 248;
            if (hexColor && hexColor.startsWith("#") && hexColor.length === 7) {
                r = parseInt(hexColor.slice(1, 3), 16);
                g = parseInt(hexColor.slice(3, 5), 16);
                b = parseInt(hexColor.slice(5, 7), 16);
            }
            gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.38)`);
            gradient.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, 0.08)`);
            gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.0)`);
            return gradient;
        } catch (e) {
            return "rgba(56, 189, 248, 0.15)";
        }
    }

    function updateChartStats(dataArr, labels, formatFn, isCumulative = false) {
        if (!elements.statPeak || !elements.statAvg || !elements.statTotal) return;
        if (!dataArr || dataArr.length === 0) {
            elements.statPeak.textContent = "-";
            elements.statAvg.textContent = "-";
            elements.statTotal.textContent = "-";
            return;
        }

        let maxVal = -Infinity;
        let maxIdx = 0;
        let sum = 0;
        for (let i = 0; i < dataArr.length; i++) {
            const v = Number(dataArr[i]) || 0;
            sum += v;
            if (v > maxVal) {
                maxVal = v;
                maxIdx = i;
            }
        }
        if (maxVal === -Infinity) maxVal = 0;
        const avg = dataArr.length > 0 ? (sum / dataArr.length) : 0;
        const peakLabel = (labels && labels[maxIdx]) ? ` (${labels[maxIdx]})` : "";

        if (isCumulative) {
            const endVal = dataArr[dataArr.length - 1] || 0;
            elements.statPeak.textContent = `${formatFn(endVal)}${peakLabel}`;
            elements.statAvg.textContent = `${formatFn(avg)} / Step`;
            elements.statTotal.textContent = formatFn(endVal);
        } else {
            elements.statPeak.textContent = `${formatFn(maxVal)}${peakLabel}`;
            elements.statAvg.textContent = formatFn(avg);
            elements.statTotal.textContent = formatFn(sum);
        }
    }

    function renderTimelineChart() {
        if (!elements.chartTimeline || !cachedAnalyticsData) return;
        const ctx = elements.chartTimeline.getContext("2d");

        const data = cachedAnalyticsData;
        const timeline = data.timeline || [];
        const isSingleStreamer = Boolean(data.selected_streamer);
        const streamerName = isSingleStreamer ? (data.selected_streamer.display_name || data.selected_streamer.username) : "Alle Streamer";

        // Sync dropdown & pills active state
        if (elements.metricSelect && elements.metricSelect.value !== analyticsMetric) {
            elements.metricSelect.value = analyticsMetric;
        }
        if (elements.metricPills) {
            elements.metricPills.forEach(p => {
                p.classList.toggle("active", p.getAttribute("data-metric") === analyticsMetric);
            });
        }

        if (timeline.length === 0) {
            if (chartTimelineInstance) {
                chartTimelineInstance.destroy();
                chartTimelineInstance = null;
            }
            if (elements.timelineTitle) elements.timelineTitle.textContent = "Keine Daten im Zeitfenster";
            if (elements.timelineSub) elements.timelineSub.textContent = "Im gewählten Zeitraum wurden keine Geschenke verzeichnet.";
            if (elements.statPeak) elements.statPeak.textContent = "-";
            if (elements.statAvg) elements.statAvg.textContent = "-";
            if (elements.statTotal) elements.statTotal.textContent = "-";
            return;
        }

        const labels = timeline.map(t => t.label || t.bucket);
        let chartType = analyticsChartType || "line";
        let datasets = [];
        let scales = {
            x: {
                grid: { color: "rgba(255, 255, 255, 0.05)" },
                ticks: { color: "#8b949e", font: { family: "monospace", size: 9 }, maxTicksLimit: 7 }
            },
            y: {
                position: "left",
                grid: { color: "rgba(255, 255, 255, 0.05)" },
                ticks: { color: "#8b949e", font: { family: "monospace", size: 9 } }
            }
        };

        const isArea = chartType === "area";
        const baseType = isArea ? "line" : chartType;

        if (analyticsMetric === "multi" && !isSingleStreamer && data.multi_streamer_datasets && data.multi_streamer_datasets.length > 0) {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Top-Streamer Vergleich (Coins)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Chronologische Entwicklung der aktivsten Streamer`;
            scales.y.ticks.color = "#38bdf8";
            scales.y.ticks.callback = v => formatNumber(v);
            const palette = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf"];
            datasets = data.multi_streamer_datasets.map((s, idx) => {
                const col = palette[idx % palette.length];
                return {
                    label: `@${s.username}`,
                    data: s.data,
                    borderColor: col,
                    backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                    borderWidth: 2,
                    pointRadius: 2.5,
                    tension: 0.35,
                    fill: isArea,
                };
            });
            // Total coins over time across timeline
            const totalCoinsPerBucket = timeline.map(t => t.coins || 0);
            updateChartStats(totalCoinsPerBucket, labels, v => `${formatNumber(v)} Coins`);
        } else if (analyticsMetric === "eur") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Netto Creator-Auszahlung (€)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Netto-Erlöse in Euro · ${streamerName}`;
            scales.y.ticks.color = "#10b981";
            scales.y.ticks.callback = v => `€${formatNumber(v)}`;
            const col = "#10b981";
            const vals = timeline.map(t => t.eur_net || 0);
            datasets = [{
                type: baseType,
                label: "Netto EUR",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => formatCurrency(v, "EUR"));
        } else if (analyticsMetric === "usd") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Netto Creator-Auszahlung ($)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Netto-Erlöse in US-Dollar · ${streamerName}`;
            scales.y.ticks.color = "#06b6d4";
            scales.y.ticks.callback = v => `$${formatNumber(v)}`;
            const col = "#06b6d4";
            const vals = timeline.map(t => t.usd_net || 0);
            datasets = [{
                type: baseType,
                label: "Netto USD",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => formatCurrency(v, "USD"));
        } else if (analyticsMetric === "gross") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Brutto Zuschauer-Kaufwert (€)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Kaufwert aller TikTok-Münzen durch Zuschauer in EUR · ${streamerName}`;
            scales.y.ticks.color = "#f59e0b";
            scales.y.ticks.callback = v => `€${formatNumber(v)}`;
            const col = "#f59e0b";
            const vals = timeline.map(t => t.eur_gross || 0);
            datasets = [{
                type: baseType,
                label: "Brutto EUR",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => formatCurrency(v, "EUR"));
        } else if (analyticsMetric === "gross_usd") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Brutto Zuschauer-Kaufwert ($)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Kaufwert aller TikTok-Münzen durch Zuschauer in USD · ${streamerName}`;
            scales.y.ticks.color = "#fbbf24";
            scales.y.ticks.callback = v => `$${formatNumber(v)}`;
            const col = "#fbbf24";
            const vals = timeline.map(t => t.usd_gross || 0);
            datasets = [{
                type: baseType,
                label: "Brutto USD",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => formatCurrency(v, "USD"));
        } else if (analyticsMetric === "cumulative_eur") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Kumulierte Netto-Einnahmen (€)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Aufsummierte Gesamterlöse über die Zeit · ${streamerName}`;
            scales.y.ticks.color = "#22c55e";
            scales.y.ticks.callback = v => `€${formatNumber(v)}`;
            const col = "#22c55e";
            let runSum = 0;
            const vals = timeline.map(t => {
                runSum += (t.eur_net || 0);
                return Math.round(runSum * 100) / 100;
            });
            datasets = [{
                type: baseType,
                label: "Kumulativ EUR",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2.5,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.25,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => formatCurrency(v, "EUR"), true);
        } else if (analyticsMetric === "cumulative_coins") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Kumulierte TikTok-Münzen (💎)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Aufsummiertes Münzvolumen über die Zeit · ${streamerName}`;
            scales.y.ticks.color = "#a855f7";
            scales.y.ticks.callback = v => formatNumber(v);
            const col = "#a855f7";
            let runSum = 0;
            const vals = timeline.map(t => {
                runSum += (t.coins || 0);
                return runSum;
            });
            datasets = [{
                type: baseType,
                label: "Kumulativ Coins",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2.5,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.25,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => `${formatNumber(v)} Coins`, true);
        } else if (analyticsMetric === "coins") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `TikTok Diamanten & Münzen (💎)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Erhaltene TikTok-Münzen · ${streamerName}`;
            scales.y.ticks.color = "#38bdf8";
            scales.y.ticks.callback = v => formatNumber(v);
            const col = "#38bdf8";
            const vals = timeline.map(t => t.coins || 0);
            datasets = [{
                type: baseType,
                label: "Coins",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => `${formatNumber(v)} Coins`);
        } else if (analyticsMetric === "events") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Gift-Events & Transaktionen (🎁)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Anzahl Geschenk-Buchungen · ${streamerName}`;
            scales.y.ticks.color = "#ec4899";
            scales.y.ticks.callback = v => formatNumber(v);
            const col = "#ec4899";
            const vals = timeline.map(t => t.events_count || 0);
            datasets = [{
                type: baseType,
                label: "Gift-Events",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => `${formatNumber(v)} Events`);
        } else if (analyticsMetric === "gifters") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Aktive Spender (👤)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Eindeutige Gifter pro Zeitintervall · ${streamerName}`;
            scales.y.ticks.color = "#8b5cf6";
            scales.y.ticks.callback = v => formatNumber(v);
            const col = "#8b5cf6";
            const vals = timeline.map(t => t.unique_gifters || 0);
            datasets = [{
                type: baseType,
                label: "Spender",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => `${formatNumber(v)} Spender`);
        } else if (analyticsMetric === "avg_gifter") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Ø Netto-Wert pro Spender (€)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Durchschnittlicher Ertrag je Gifter · ${streamerName}`;
            scales.y.ticks.color = "#eab308";
            scales.y.ticks.callback = v => `€${v}`;
            const col = "#eab308";
            const vals = timeline.map(t => {
                if (t.avg_eur_per_gifter !== undefined) return t.avg_eur_per_gifter;
                return t.unique_gifters > 0 ? (Math.round((t.eur_net / t.unique_gifters) * 100) / 100) : 0;
            });
            datasets = [{
                type: baseType,
                label: "Ø € / Spender",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => formatCurrency(v, "EUR"));
        } else if (analyticsMetric === "avg_gift") {
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Ø Münzen pro Geschenk (💎)`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Durchschnittliche Geschenkgröße · ${streamerName}`;
            scales.y.ticks.color = "#14b8a6";
            scales.y.ticks.callback = v => `${formatNumber(v)}`;
            const col = "#14b8a6";
            const vals = timeline.map(t => {
                if (t.avg_coins_per_gift !== undefined) return t.avg_coins_per_gift;
                return t.events_count > 0 ? (Math.round((t.coins / t.events_count) * 10) / 10) : 0;
            });
            datasets = [{
                type: baseType,
                label: "Ø Coins / Gift",
                data: vals,
                borderColor: col,
                backgroundColor: isArea ? createChartGradient(ctx, col) : (baseType === "bar" ? col : "transparent"),
                borderWidth: 2,
                borderRadius: baseType === "bar" ? 3 : 0,
                fill: isArea,
                tension: 0.35,
                pointRadius: 2,
            }];
            updateChartStats(vals, labels, v => `${formatNumber(v)} Coins`);
        } else {
            // Mode "both" (default combo: Coins Bar + Netto EUR Line)
            if (elements.timelineTitle) elements.timelineTitle.textContent = `Einnahmen- & Coin-Verlauf`;
            if (elements.timelineSub) elements.timelineSub.textContent = `Balken: Coins (links) | Linie: Netto EUR (rechts) · ${streamerName}`;
            scales.y.title = { display: true, text: "Coins", color: "#38bdf8", font: { family: "monospace", size: 9 } };
            scales.y.ticks.color = "#38bdf8";
            scales.y.ticks.callback = v => formatNumber(v);
            scales.yEur = {
                position: "right",
                grid: { drawOnChartArea: false },
                ticks: { color: "#10b981", font: { family: "monospace", size: 9 }, callback: v => `€${formatNumber(v)}` },
                title: { display: true, text: "Netto EUR", color: "#10b981", font: { family: "monospace", size: 9 } }
            };
            const coinVals = timeline.map(t => t.coins || 0);
            const eurVals = timeline.map(t => t.eur_net || 0);
            datasets = [
                {
                    type: "bar",
                    label: "Coins",
                    data: coinVals,
                    backgroundColor: "rgba(56, 189, 248, 0.65)",
                    borderColor: "#38bdf8",
                    borderWidth: 1,
                    borderRadius: 2,
                    yAxisID: "y",
                },
                {
                    type: "line",
                    label: "Netto EUR",
                    data: eurVals,
                    borderColor: "#10b981",
                    backgroundColor: isArea ? createChartGradient(ctx, "#10b981") : "rgba(16, 185, 129, 0.1)",
                    borderWidth: 2.2,
                    pointRadius: 2.5,
                    fill: isArea,
                    tension: 0.35,
                    yAxisID: "yEur",
                }
            ];
            updateChartStats(eurVals, labels, v => formatCurrency(v, "EUR"));
        }

        if (chartTimelineInstance && chartTimelineInstance.config.type === baseType) {
            chartTimelineInstance.data.labels = labels;
            chartTimelineInstance.data.datasets = datasets;
            chartTimelineInstance.options.scales = scales;
            chartTimelineInstance.options.plugins.legend.display = datasets.length > 1;
            chartTimelineInstance.update("none");
            return;
        }

        if (chartTimelineInstance) {
            chartTimelineInstance.destroy();
            chartTimelineInstance = null;
        }

        chartTimelineInstance = new Chart(ctx, {
            type: baseType,
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: {
                        display: datasets.length > 1,
                        labels: { color: "#8b949e", font: { family: "monospace", size: 10 } }
                    },
                    tooltip: {
                        backgroundColor: "#161b22",
                        titleColor: "#c9d1d9",
                        bodyColor: "#58a6ff",
                        borderColor: "#30363d",
                        borderWidth: 1,
                        padding: 8,
                        titleFont: { family: "monospace", size: 11 },
                        bodyFont: { family: "monospace", size: 11 },
                    }
                },
                scales: scales
            }
        });
    }

    function renderStreamerCompareChart(ranking) {
        if (!elements.chartStreamerCompare) return;
        const ctx = elements.chartStreamerCompare.getContext("2d");

        if (!ranking || ranking.length === 0) {
            if (chartStreamerCompareInstance) {
                chartStreamerCompareInstance.destroy();
                chartStreamerCompareInstance = null;
            }
            return;
        }
        const top = ranking.slice(0, 6);
        const labels = top.map(s => s.display_name || s.username);
        const dataVals = top.map(s => s.eur_net || 0);

        if (chartStreamerCompareInstance) {
            chartStreamerCompareInstance.data.labels = labels;
            chartStreamerCompareInstance.data.datasets[0].data = dataVals;
            chartStreamerCompareInstance.update("none");
            return;
        }

        chartStreamerCompareInstance = new Chart(ctx, {
            type: "bar",
            data: {
                labels: labels,
                datasets: [{
                    label: "Netto EUR (€)",
                    data: dataVals,
                    backgroundColor: [
                        "#38bdf8", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#64748b"
                    ],
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: "y",
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { color: "rgba(255, 255, 255, 0.05)" },
                        ticks: { color: "#8b949e", font: { family: "monospace", size: 9 }, callback: v => `€${v}` }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: "#e6edf3", font: { family: "monospace", size: 10 } }
                    }
                }
            }
        });
    }

    function renderTopGifters(gifters) {
        if (!elements.topGiftersContainer) return;
        if (!gifters || gifters.length === 0) {
            elements.topGiftersContainer.innerHTML = '<div class="ma-empty-state">Keine Spenderdaten im Zeitraum.</div>';
            return;
        }

        let html = "";
        gifters.slice(0, 10).forEach((g, idx) => {
            const rank = idx + 1;
            const rankClass = rank === 1 ? "gold" : (rank === 2 ? "silver" : (rank === 3 ? "bronze" : ""));
            const medal = rank === 1 ? "🥇" : (rank === 2 ? "🥈" : (rank === 3 ? "🥉" : `#${rank}`));
            const name = g.sender_nickname || g.sender_username || "Anonym";
            const txText = `${formatNumber(g.gifts_sent || 0)} Gifts · ${formatNumber(g.transactions || 0)}x`;

            html += `
                <div class="ma-gifter-item">
                    <div class="ma-gifter-left">
                        <span class="ma-gifter-rank ${rankClass}">${medal}</span>
                        <div>
                            <div class="ma-gifter-name">${escapeHtml(name)}</div>
                            <div class="ma-gifter-sub">@${escapeHtml(g.sender_username)} · ${txText}</div>
                        </div>
                    </div>
                    <div class="ma-gifter-coins">+${formatNumber(g.total_coins)} 💎</div>
                </div>
            `;
        });
        elements.topGiftersContainer.innerHTML = html;
    }

    function renderGiftDistChart(topGifts) {
        if (!elements.chartGiftDist) return;
        const ctx = elements.chartGiftDist.getContext("2d");

        if (!topGifts || topGifts.length === 0) {
            if (chartGiftDistInstance) {
                chartGiftDistInstance.destroy();
                chartGiftDistInstance = null;
            }
            if (elements.topGiftsList) elements.topGiftsList.innerHTML = '<div class="ma-empty-state">Keine Geschenke.</div>';
            return;
        }

        const labels = topGifts.slice(0, 6).map(g => g.gift_name);
        const dataVals = topGifts.slice(0, 6).map(g => g.total_coins);
        const palette = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf"];

        if (chartGiftDistInstance) {
            chartGiftDistInstance.data.labels = labels;
            chartGiftDistInstance.data.datasets[0].data = dataVals;
            chartGiftDistInstance.update("none");
        } else {
            chartGiftDistInstance = new Chart(ctx, {
                type: "doughnut",
                data: {
                    labels: labels,
                    datasets: [{
                        data: dataVals,
                        backgroundColor: palette,
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: "right",
                            labels: { color: "#8b949e", font: { family: "monospace", size: 10 } }
                        }
                    }
                }
            });
        }

        if (elements.topGiftsList) {
            let listHtml = "";
            topGifts.slice(0, 5).forEach(g => {
                listHtml += `
                    <div class="ma-gift-dist-item">
                        <span class="ma-gift-dist-name">🎁 ${escapeHtml(g.gift_name)} (${formatNumber(g.total_quantity)}x)</span>
                        <span class="ma-gift-dist-val">${formatNumber(g.total_coins)} Coins · ${formatCurrency(g.eur_net)}</span>
                    </div>
                `;
            });
            elements.topGiftsList.innerHTML = listHtml;
        }
    }

    function renderTimeOfDayChart(timeData) {
        if (!elements.chartTimeOfDay) return;
        const ctx = elements.chartTimeOfDay.getContext("2d");

        const labels = Array.from({ length: 24 }, (_, i) => `${i}h`);
        const values = new Array(24).fill(0);

        if (Array.isArray(timeData)) {
            timeData.forEach(item => {
                const hour = parseInt(item.hour !== undefined ? item.hour : item.bucket, 10);
                if (!isNaN(hour) && hour >= 0 && hour < 24) {
                    values[hour] = item.coins || item.total_coins || 0;
                }
            });
        }

        if (chartTimeOfDayInstance) {
            chartTimeOfDayInstance.data.labels = labels;
            chartTimeOfDayInstance.data.datasets[0].data = values;
            chartTimeOfDayInstance.update("none");
            return;
        }

        chartTimeOfDayInstance = new Chart(ctx, {
            type: "bar",
            data: {
                labels: labels,
                datasets: [{
                    label: "Coins",
                    data: values,
                    backgroundColor: "#38bdf8",
                    borderRadius: 3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: "#8b949e", font: { family: "monospace", size: 9 } }
                    },
                    y: {
                        grid: { color: "rgba(255, 255, 255, 0.05)" },
                        ticks: { color: "#8b949e", font: { family: "monospace", size: 9 } }
                    }
                }
            }
        });
    }

    // =====================================================================
    // 4b. SPENDER-RADAR & WHALES (TAB 4)
    // =====================================================================

    // Web Audio Synthesizer for Whale Alerts (Optional Sound)
    function initAudioContext() {
        if (!audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) audioCtx = new AudioContext();
        }
        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume();
        }
    }

    function playWhaleAlertChime(isWhale = false) {
        if (!whaleSoundEnabled) return;
        try {
            initAudioContext();
            if (!audioCtx) return;
            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);

            const freq = isWhale ? 880 : 660;
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, now);
            osc.frequency.exponentialRampToValueAtTime(isWhale ? 1320 : 990, now + 0.15);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

            osc.start(now);
            osc.stop(now + 0.45);
        } catch (e) {}
    }

    function triggerWhaleHaptic(tier) {
        if (tier === "whale") {
            triggerHaptic("heavy");
            if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback) {
                window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
            }
        } else {
            triggerHaptic("medium");
        }
    }

    function renderTierBadge(tier) {
        tier = (tier || "dolphin").toLowerCase();
        if (tier === "whale") {
            return `<span class="ma-tier-tag whale">🐋 WHALE</span>`;
        } else if (tier === "shark") {
            return `<span class="ma-tier-tag shark">🦈 SHARK</span>`;
        }
        return `<span class="ma-tier-tag dolphin">🐬 DOLPHIN</span>`;
    }

    // Polling Supervisor for Radar Tab (Smart 12s interval, stops in background)
    function startRadarPolling() {
        stopRadarPolling();
        if (activeTab === "tab-radar" && !document.hidden) {
            radarPollInterval = setInterval(() => {
                if (activeTab === "tab-radar" && !document.hidden) {
                    if (radarSubTab === "donors") {
                        fetchRadarData(true);
                    } else if (radarSubTab === "alerts") {
                        fetchWhaleAlerts(true);
                    }
                    fetchWhaleTicker(true);
                } else {
                    stopRadarPolling();
                }
            }, 12000);
        }
    }

    function stopRadarPolling() {
        if (radarPollInterval) {
            clearInterval(radarPollInterval);
            radarPollInterval = null;
        }
    }

    // 1. Fetch Donors List & Radar KPIs
    async function fetchRadarData(silent = false) {
        if (!elements.radarDonorsContainer) return;

        let url = `/api/miniapp/radar?period=${encodeURIComponent(currentPeriod)}`;
        if (radarTier && radarTier !== "all") {
            url += `&min_tier=${encodeURIComponent(radarTier)}`;
        }
        if (radarCrossOnly) {
            url += `&cross_only=true`;
        }
        if (radarVipOnly) {
            url += `&vip_only=true`;
        }
        if (radarSearch && radarSearch.trim()) {
            url += `&search=${encodeURIComponent(radarSearch.trim())}`;
        }

        try {
            const res = await fetch(url, { headers: getAuthHeaders() });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    isWhitelisted = false;
                    updateRadarAuthUI();
                    return;
                }
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            if (!data.authorized) {
                isWhitelisted = false;
                updateRadarAuthUI();
                return;
            }
            isWhitelisted = true;
            updateRadarAuthUI();
            cachedRadarData = data;
            renderRadarData(data);
        } catch (err) {
            console.error("Fehler beim Laden des Spender-Radars:", err);
            if (!silent) {
                elements.radarDonorsContainer.innerHTML = `
                    <div class="ma-empty-state">
                        <div class="ma-empty-icon">⚠️</div>
                        <div>Fehler beim Laden der Radar-Daten</div>
                    </div>
                `;
            }
        }
    }

    function renderRadarData(data) {
        const kpis = data.kpis || {};
        const donors = data.donors || [];

        // Update KPIs
        if (elements.radarKpiWhales) elements.radarKpiWhales.textContent = formatNumber(kpis.whales || 0);
        if (elements.radarKpiSharks) elements.radarKpiSharks.textContent = formatNumber(kpis.sharks || 0);
        if (elements.radarKpiDolphins) elements.radarKpiDolphins.textContent = formatNumber(kpis.dolphins || 0);
        if (elements.radarKpiCross) elements.radarKpiCross.textContent = formatNumber(kpis.cross_streamer_whales || 0);
        if (elements.radarKpiVip) elements.radarKpiVip.textContent = formatNumber(kpis.vip_donors || 0);
        if (elements.radarTotalBadge) elements.radarTotalBadge.textContent = `${donors.length} erfasst`;

        if (!donors.length) {
            elements.radarDonorsContainer.innerHTML = `
                <div class="ma-empty-state">
                    <div class="ma-empty-icon">🔍</div>
                    <div>Keine Spender in dieser Auswahl gefunden</div>
                </div>
            `;
            return;
        }

        let html = "";
        donors.forEach((d, idx) => {
            const rank = idx + 1;
            const rankClass = rank === 1 ? "rank-1" : (rank === 2 ? "rank-2" : (rank === 3 ? "rank-3" : ""));
            const tier = (d.tier || "dolphin").toLowerCase();
            const tierEmoji = tier === "whale" ? "🐋" : (tier === "shark" ? "🦈" : "🐬");
            const tierLabel = tier.toUpperCase();

            const isVip = !!d.is_vip;
            const isCross = !!d.is_cross_streamer;
            const streamerCount = parseInt(d.streamer_count || 1, 10);

            const displayUname = escapeHtml(d.username || "anonym");
            const displayNick = (d.display_name && d.display_name !== d.username) ? escapeHtml(d.display_name) : "";

            const coins = formatNumber(d.total_coins || 0);
            const eurNet = formatCurrency(d.total_eur_net || 0, "EUR");
            const giftsCount = formatNumber(d.total_gifts || 0);

            html += `
                <div class="ma-donor-card tier-${tier}" data-donor-username="${displayUname}" style="cursor: pointer;">
                    <div class="ma-donor-header">
                        <div class="ma-donor-ident">
                            <div class="ma-donor-rank ${rankClass}">#${rank}</div>
                            <div class="ma-donor-names">
                                <div class="ma-donor-uname">
                                    <span>${displayUname}</span>
                                    <button type="button" class="ma-vip-star-btn ${isVip ? 'is-vip' : ''}" data-action="toggle-vip" data-username="${displayUname}" title="VIP-Status umschalten">
                                        ⭐
                                    </button>
                                </div>
                                ${displayNick ? `<div class="ma-donor-nick">${displayNick}</div>` : ""}
                            </div>
                        </div>
                        <div class="ma-donor-finance">
                            <div class="ma-donor-coins">💎 ${coins}</div>
                            <div class="ma-donor-eur">+${eurNet}</div>
                        </div>
                    </div>

                    <div class="ma-donor-meta-row">
                        <div class="ma-donor-tags">
                            <span class="ma-tier-tag ${tier}">${tierEmoji} ${tierLabel}</span>
                            ${isCross ? `<span class="ma-cross-tag">⚡ ${streamerCount} Kanäle</span>` : ""}
                            ${d.has_notes ? `<span style="font-size: 10px; color: #fbbf24;" title="Notizen vorhanden">📝</span>` : ""}
                        </div>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <span>🎁 ${giftsCount} Gifts</span>
                            ${d.last_seen ? `<span>· ${getRelativeTime(d.last_seen)}</span>` : ""}
                            <span style="font-size: 11px; color: var(--text-muted);">›</span>
                        </div>
                    </div>
                </div>
            `;
        });

        elements.radarDonorsContainer.innerHTML = html;

        // Click handlers on donor cards & VIP stars
        elements.radarDonorsContainer.querySelectorAll(".ma-donor-card").forEach(card => {
            card.addEventListener("click", (e) => {
                if (e.target.closest("[data-action='toggle-vip']")) return;
                const uname = card.getAttribute("data-donor-username");
                if (uname) {
                    triggerHaptic("light");
                    openDonorDossier(uname);
                }
            });
        });

        elements.radarDonorsContainer.querySelectorAll("[data-action='toggle-vip']").forEach(starBtn => {
            starBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const uname = starBtn.getAttribute("data-username");
                if (uname) toggleDonorVip(uname, starBtn, e);
            });
        });
    }

    // 2. Fetch Live Whale Ticker
    async function fetchWhaleTicker(silent = false) {
        if (!elements.whaleTickerTrack) return;
        try {
            const res = await fetch(`/api/donor-radar/whale-alerts?min_coins=1000&limit=15`, { headers: getAuthHeaders() });
            if (!res.ok) return;
            const json = await res.json();
            const alerts = json.alerts || [];

            if (!alerts.length) {
                elements.whaleTickerTrack.innerHTML = `<span class="mono muted" style="font-size: 11px; padding: 0 8px;">Noch keine Whale-Alerts im System</span>`;
                return;
            }

            // Check if there is a newly arrived high-value gift
            let maxId = lastSeenWhaleAlertId;
            let hasNewAlert = false;
            let highestNewTier = "dolphin";

            alerts.forEach(a => {
                if (a.id > maxId) {
                    if (lastSeenWhaleAlertId > 0) {
                        hasNewAlert = true;
                        if (a.tier === "whale") highestNewTier = "whale";
                        else if (highestNewTier !== "whale" && a.tier === "shark") highestNewTier = "shark";
                    }
                    if (a.id > maxId) maxId = a.id;
                }
            });

            if (hasNewAlert && lastSeenWhaleAlertId > 0) {
                lastSeenWhaleAlertId = maxId;
                triggerWhaleHaptic(highestNewTier);
                playWhaleAlertChime(highestNewTier === "whale");
                const topAlert = alerts[0];
                showToast(`🐋 Whale-Alert: @${topAlert.sender_username} schenkte ${formatNumber(topAlert.total_coins)} Coins an @${topAlert.streamer_username}!`);
            } else if (maxId > lastSeenWhaleAlertId) {
                lastSeenWhaleAlertId = maxId;
            }

            let chipsHtml = "";
            alerts.slice(0, 10).forEach(a => {
                const tier = (a.tier || "shark").toLowerCase();
                const tierEmoji = tier === "whale" ? "🐋" : "🦈";
                const uname = escapeHtml(a.sender_username || "anonym");
                const coins = formatNumber(a.total_coins || 0);
                const sName = escapeHtml(a.streamer_username || "");

                chipsHtml += `
                    <div class="ma-ticker-chip" data-donor="${uname}" title="${uname} schenkte ${coins} Coins an @${sName}">
                        <span>${tierEmoji}</span>
                        <strong>${uname}</strong>
                        <span style="color: #fbbf24;">💎 ${coins}</span>
                        <span class="muted" style="font-size: 9.5px;">→ @${sName}</span>
                    </div>
                `;
            });

            elements.whaleTickerTrack.innerHTML = chipsHtml;

            // Clicking any ticker chip opens the donor dossier
            elements.whaleTickerTrack.querySelectorAll(".ma-ticker-chip").forEach(chip => {
                chip.addEventListener("click", () => {
                    const uname = chip.getAttribute("data-donor");
                    if (uname) {
                        triggerHaptic("light");
                        openDonorDossier(uname);
                    }
                });
            });
        } catch (e) {
            console.error("Whale Ticker Error:", e);
        }
    }

    // 3. Fetch Whale-Alerts Feed (Subtab 2)
    async function fetchWhaleAlerts(silent = false) {
        if (!elements.whaleAlertsContainer) return;
        if (!silent) {
            elements.whaleAlertsContainer.innerHTML = `
                <div class="ma-empty-state">
                    <div class="ma-empty-icon">⏳</div>
                    <div>Lade Live-Großspenden (&ge; ${formatNumber(whaleAlertMinCoins)} Coins)...</div>
                </div>
            `;
        }

        try {
            const res = await fetch(`/api/donor-radar/whale-alerts?min_coins=${whaleAlertMinCoins}&limit=35`, { headers: getAuthHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const alerts = json.alerts || [];

            if (elements.whaleAlertCountBadge) {
                elements.whaleAlertCountBadge.textContent = alerts.length;
                elements.whaleAlertCountBadge.style.display = alerts.length ? "inline-block" : "none";
            }

            if (!alerts.length) {
                elements.whaleAlertsContainer.innerHTML = `
                    <div class="ma-empty-state">
                        <div class="ma-empty-icon">🔍</div>
                        <div>Keine Großspenden über ${formatNumber(whaleAlertMinCoins)} Coins erfasst</div>
                    </div>
                `;
                return;
            }

            let html = "";
            alerts.forEach(a => {
                const tier = (a.tier || "shark").toLowerCase();
                const tierEmoji = tier === "whale" ? "🐋" : (tier === "shark" ? "🦈" : "🐬");
                const giftImg = a.gift_icon_url || "/static/avatar_default.png";
                const giftName = escapeHtml(a.gift_name || "Geschenk");
                const repeat = parseInt(a.repeat_count || 1, 10);
                const sender = escapeHtml(a.sender_username || "anonym");
                const streamer = escapeHtml(a.streamer_display_name || a.streamer_username || "");
                const streamerAvatar = a.streamer_avatar_url || "/static/avatar_default.png";
                const coins = formatNumber(a.total_coins || 0);
                const eurNet = formatCurrency(a.eur_net || 0, "EUR");
                const isVip = !!a.is_vip;

                html += `
                    <div class="ma-alert-card tier-${tier}" data-donor="${sender}">
                        <div class="ma-alert-left">
                            <img src="${escapeHtml(giftImg)}" class="ma-alert-gift-img" onerror="this.src='/static/avatar_default.png'" />
                            <div style="min-width: 0; flex: 1;">
                                <div class="ma-alert-sender">
                                    <span>${tierEmoji}</span>
                                    <span>${sender}</span>
                                    ${isVip ? '<span style="color:#fbbf24;">⭐</span>' : ''}
                                </div>
                                <div class="ma-alert-target">
                                    <img src="${escapeHtml(streamerAvatar)}" style="width: 14px; height: 14px; border-radius: 50%; object-fit: cover;" onerror="this.src='/static/avatar_default.png'" />
                                    <span>an @${streamer}</span>
                                    <span>· ${repeat > 1 ? repeat + 'x ' : ''}${giftName}</span>
                                </div>
                            </div>
                        </div>
                        <div class="ma-alert-right">
                            <div class="ma-alert-coins">💎 ${coins}</div>
                            <div class="ma-alert-eur">+${eurNet}</div>
                            <div class="ma-alert-time">${a.created_at ? getRelativeTime(a.created_at) : ''}</div>
                        </div>
                    </div>
                `;
            });

            elements.whaleAlertsContainer.innerHTML = html;

            elements.whaleAlertsContainer.querySelectorAll(".ma-alert-card").forEach(c => {
                c.addEventListener("click", () => {
                    const uname = c.getAttribute("data-donor");
                    if (uname) {
                        triggerHaptic("light");
                        openDonorDossier(uname);
                    }
                });
            });
        } catch (e) {
            console.error("Whale Alerts Feed Error:", e);
            if (!silent) {
                elements.whaleAlertsContainer.innerHTML = `
                    <div class="ma-empty-state">
                        <div class="ma-empty-icon">⚠️</div>
                        <div>Fehler beim Laden des Whale-Alert Feeds</div>
                    </div>
                `;
            }
        }
    }

    // 4. Fetch Loyalty & Frontenwechsler Data (Subtab 3)
    async function fetchLoyaltyData(silent = false) {
        if (!elements.frontenwechslerContainer && !elements.overlapMatrixContainer) return;
        if (!silent) {
            if (elements.frontenwechslerContainer) {
                elements.frontenwechslerContainer.innerHTML = `
                    <div class="ma-empty-state"><div class="ma-empty-icon">⏳</div><div>Analysiere Frontenwechsler...</div></div>
                `;
            }
            if (elements.overlapMatrixContainer) {
                elements.overlapMatrixContainer.innerHTML = `
                    <div class="ma-empty-state"><div class="ma-empty-icon">⏳</div><div>Berechne Überschneidungs-Matrix...</div></div>
                `;
            }
        }

        try {
            const res = await fetch(`/api/donor-radar/loyalty-and-overlap?days_recent=${loyaltyDaysRecent}&min_coins=50`, { headers: getAuthHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const data = json.data || {};
            const shifters = data.frontenwechsler || [];
            const overlaps = data.overlap_matrix || [];

            if (elements.frontenwechslerBadge) {
                elements.frontenwechslerBadge.textContent = `${shifters.length} erkannt`;
            }
            if (elements.overlapPairsBadge) {
                elements.overlapPairsBadge.textContent = `${overlaps.length} Paare`;
            }

            // Render Frontenwechsler
            if (elements.frontenwechslerContainer) {
                if (!shifters.length) {
                    elements.frontenwechslerContainer.innerHTML = `
                        <div class="ma-empty-state">
                            <div class="ma-empty-icon">🤝</div>
                            <div>Keine Frontenwechsler im gewählten Zeitraum (${loyaltyDaysRecent} Tage) erkannt.</div>
                        </div>
                    `;
                } else {
                    let sHtml = "";
                    shifters.forEach(s => {
                        const uname = escapeHtml(s.username || "anonym");
                        const fromS = s.from_streamer || {};
                        const toS = s.to_streamer || {};
                        const loyalty = s.loyalty || {};
                        const score = loyalty.score || 50;
                        const classLabel = escapeHtml(loyalty.label || "Spender");
                        const classColor = loyalty.color || "#38bdf8";

                        sHtml += `
                            <div class="ma-shifter-card" data-donor="${uname}">
                                <div class="ma-shifter-head">
                                    <div class="ma-shifter-uname">
                                        <span>🔀</span>
                                        <strong>${uname}</strong>
                                        ${s.is_vip ? '<span style="color:#fbbf24;">⭐</span>' : ''}
                                    </div>
                                    <span class="ma-shifter-class" style="background: ${classColor}22; color: ${classColor}; border: 1px solid ${classColor}66;">
                                        ${classLabel} (${score}%)
                                    </span>
                                </div>
                                <div class="ma-shifter-flow">
                                    <div class="ma-shifter-streamer">
                                        <img src="${escapeHtml(fromS.avatar_url || '/static/avatar_default.png')}" class="ma-shifter-streamer-av" onerror="this.src='/static/avatar_default.png'" />
                                        <div class="ma-shifter-streamer-info">
                                            <div class="muted" style="font-size: 9px;">FRÜHER</div>
                                            <div>@${escapeHtml(fromS.username || '')}</div>
                                            <div class="mono" style="font-size: 10px; color: var(--text-muted);">💎 ${formatNumber(fromS.coins || 0)}</div>
                                        </div>
                                    </div>
                                    <div class="ma-shifter-arrow">➔</div>
                                    <div class="ma-shifter-streamer" style="text-align: right; justify-content: flex-end;">
                                        <div class="ma-shifter-streamer-info">
                                            <div style="font-size: 9px; color: #10b981; font-weight: 800;">NEUER FOKUS</div>
                                            <div style="color: #38bdf8;">@${escapeHtml(toS.username || '')}</div>
                                            <div class="mono" style="font-size: 10px; color: #fbbf24; font-weight: 800;">💎 ${formatNumber(toS.coins || 0)}</div>
                                        </div>
                                        <img src="${escapeHtml(toS.avatar_url || '/static/avatar_default.png')}" class="ma-shifter-streamer-av" style="border-color: #38bdf8;" onerror="this.src='/static/avatar_default.png'" />
                                    </div>
                                </div>
                            </div>
                        `;
                    });
                    elements.frontenwechslerContainer.innerHTML = sHtml;

                    elements.frontenwechslerContainer.querySelectorAll(".ma-shifter-card").forEach(c => {
                        c.addEventListener("click", () => {
                            const uname = c.getAttribute("data-donor");
                            if (uname) {
                                triggerHaptic("light");
                                openDonorDossier(uname);
                            }
                        });
                    });
                }
            }

            // Render Overlap Matrix
            if (elements.overlapMatrixContainer) {
                if (!overlaps.length) {
                    elements.overlapMatrixContainer.innerHTML = `
                        <div class="ma-empty-state">
                            <div class="ma-empty-icon">⚡</div>
                            <div>Keine Überschneidungs-Paare gefunden.</div>
                        </div>
                    `;
                } else {
                    let oHtml = "";
                    overlaps.forEach(p => {
                        const sA = escapeHtml(p.streamer_a_display_name || p.streamer_a_username || "A");
                        const sB = escapeHtml(p.streamer_b_display_name || p.streamer_b_username || "B");
                        const pctA = p.streamer_a_pct || 50;
                        const pctB = p.streamer_b_pct || 50;
                        const totalCoins = formatNumber(p.total_shared_coins || p.shared_volume_coins || 0);
                        const sharedCount = p.shared_donors_count || 1;

                        oHtml += `
                            <div class="ma-overlap-card">
                                <div class="ma-overlap-head">
                                    <div style="font-size: 12px; font-weight: 800; color: var(--text-strong);">
                                        <span>@${sA}</span> <span class="muted">&amp;</span> <span>@${sB}</span>
                                    </div>
                                    <span class="mono" style="font-size: 10.5px; color: #fbbf24; font-weight: 800;">
                                        💎 ${totalCoins}
                                    </span>
                                </div>
                                <div class="ma-overlap-split-bar">
                                    <div class="ma-split-seg-a" style="width: ${pctA}%;"></div>
                                    <div class="ma-split-seg-b" style="width: ${pctB}%;"></div>
                                </div>
                                <div class="ma-overlap-meta">
                                    <span style="color: #c084fc;">@${sA}: ${pctA}%</span>
                                    <span class="muted">👥 ${sharedCount} Spender geteilt</span>
                                    <span style="color: #38bdf8;">@${sB}: ${pctB}%</span>
                                </div>
                            </div>
                        `;
                    });
                    elements.overlapMatrixContainer.innerHTML = oHtml;
                }
            }
        } catch (e) {
            console.error("Loyalty Data Error:", e);
            if (!silent) {
                if (elements.frontenwechslerContainer) elements.frontenwechslerContainer.innerHTML = '<div class="ma-empty-state">Fehler bei Frontenwechsler</div>';
                if (elements.overlapMatrixContainer) elements.overlapMatrixContainer.innerHTML = '<div class="ma-empty-state">Fehler bei Überschneidungen</div>';
            }
        }
    }

    // 5. Donor Dossier Modal & CRM Inspection
    // 5. Donor Dossier Modal & CRM Inspection
    async function openDonorDossier(username) {
        if (!elements.modalDonorDossier || !elements.dossierBody) return;
        elements.dossierUsername.textContent = `@${username}`;
        elements.dossierTierBadge.innerHTML = "";
        elements.dossierBody.innerHTML = `
            <div class="ma-empty-state">
                <div class="ma-empty-icon">⏳</div>
                <div>Lade Spender-Dossier für @${escapeHtml(username)}...</div>
            </div>
        `;
        openModal(elements.modalDonorDossier);

        try {
            const res = await fetch(`/api/donor-radar/donors/${encodeURIComponent(username)}`, { headers: getAuthHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const payload = json.data || {};
            const profile = payload.profile || payload;
            const crm = payload.crm || {};
            const streamers = payload.streamers || [];
            const topGifts = payload.top_gifts || [];
            const recentChats = payload.recent_chats || [];
            const loyalty = payload.loyalty || {};
            const frontenwechsel = payload.frontenwechsel || {};

            const finalUsername = profile.username || username;
            const finalIsVip = profile.is_vip !== undefined ? !!profile.is_vip : (crm.is_vip !== undefined ? !!crm.is_vip : false);
            const finalTags = Array.isArray(profile.tags) && profile.tags.length ? profile.tags : (Array.isArray(crm.tags) ? crm.tags : []);
            const finalNotes = (profile.notes !== undefined && profile.notes !== null) ? profile.notes : (crm.notes || "");

            currentDossierData = {
                username: finalUsername,
                is_vip: finalIsVip,
                tags: finalTags,
                notes: finalNotes,
            };

            const tier = (profile.tier || "dolphin").toLowerCase();
            const isVip = finalIsVip;
            const displayNick = (profile.display_name && profile.display_name !== finalUsername) ? escapeHtml(profile.display_name) : "";
            const avatar = profile.avatar_url || "/static/avatar_default.png";
            const coins = formatNumber(profile.total_coins || 0);
            const eurNet = formatCurrency(profile.total_eur_net || 0, "EUR");
            const usdNet = formatCurrency(profile.total_usd_net || 0, "USD");
            const giftsCount = formatNumber(profile.total_gifts || 0);
            const tags = finalTags;
            const notes = finalNotes;

            elements.dossierUsername.textContent = `@${finalUsername}`;
            elements.dossierTierBadge.innerHTML = renderTierBadge(tier);

            // 1. Streamer distribution
            let sHtml = "";
            const totalCoinsDonor = Number(profile.total_coins || 0);
            streamers.forEach(s => {
                const sCoins = Number(s.coins_given !== undefined ? s.coins_given : (s.coins || 0));
                const pct = s.percentage !== undefined ? s.percentage : (totalCoinsDonor > 0 ? Math.round((sCoins / totalCoinsDonor) * 100) : 0);
                const sUsername = s.streamer_username || s.username || "unbekannt";
                const sAvatar = s.streamer_avatar_url || s.avatar_url || "/static/avatar_default.png";

                sHtml += `
                    <div class="ma-dossier-streamer-item">
                        <div class="ma-dossier-streamer-top">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <img src="${escapeHtml(sAvatar)}" style="width: 18px; height: 18px; border-radius: 50%; object-fit: cover;" onerror="this.src='/static/avatar_default.png'" />
                                <strong>@${escapeHtml(sUsername)}</strong>
                            </div>
                            <div class="mono" style="color: #fbbf24; font-weight: 700;">💎 ${formatNumber(sCoins)} (${pct}%)</div>
                        </div>
                        <div class="ma-dossier-bar-wrap">
                            <div class="ma-dossier-bar" style="width: ${pct}%;"></div>
                        </div>
                    </div>
                `;
            });

            // 2. Favorite Gifts
            let gHtml = "";
            topGifts.slice(0, 6).forEach(g => {
                const gCount = formatNumber(g.total_sent || g.count || g.total_repeats || 1);
                const gCoins = formatNumber(g.total_coins || g.coins || 0);
                const gIcon = g.gift_icon_url || "";
                gHtml += `
                    <div style="display: inline-flex; align-items: center; gap: 5px; background: var(--bg-surface); border: 1px solid var(--border-color); padding: 4px 8px; border-radius: 6px; font-size: 11px;">
                        ${gIcon ? `<img src="${escapeHtml(gIcon)}" style="width: 16px; height: 16px; object-fit: contain;" onerror="this.style.display='none'" />` : `<span>🎁</span>`}
                        <strong>${escapeHtml(g.gift_name || 'Geschenk')}</strong>
                        <span class="muted">(${gCount}x)</span>
                        <span style="color: #fbbf24; font-weight: 700;">💎 ${gCoins}</span>
                    </div>
                `;
            });

            // 3. Loyalty & Frontenwechsel Banner
            let loyaltyHtml = "";
            if (loyalty && (loyalty.score !== undefined || loyalty.primary_streamer)) {
                const lScore = loyalty.score || 0;
                const lColor = loyalty.color || "#38bdf8";
                const lLabel = escapeHtml(loyalty.label || "Supporter");
                const lBadge = escapeHtml(loyalty.badge || `${lScore}% Treue`);
                const lPrimary = escapeHtml(loyalty.primary_streamer || "");
                const lCoins = formatNumber(loyalty.primary_coins || 0);

                loyaltyHtml = `
                    <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 8px; padding: 8px 10px; margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <div style="font-size: 11.5px; font-weight: 700; color: ${lColor};">${lBadge}</div>
                            <span class="mono muted" style="font-size: 10px;">${lLabel}</span>
                        </div>
                        ${lPrimary ? `<div style="font-size: 10.5px; color: var(--text-muted);">Stamm-Kanal: <strong style="color: var(--text-main);">@${lPrimary}</strong> (💎 ${lCoins})</div>` : ''}
                        ${(frontenwechsel && frontenwechsel.is_shifted) ? `
                            <div style="margin-top: 5px; font-size: 10px; color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 3px 6px; border-radius: 4px;">
                                ⚠️ Frontenwechsel: Von @${escapeHtml(frontenwechsel.from_streamer)} ➔ Neuer Fokus @${escapeHtml(frontenwechsel.to_streamer)}
                            </div>
                        ` : ''}
                    </div>
                `;
            }

            // 4. Recent Chats
            let chatHtml = "";
            if (recentChats && recentChats.length) {
                let chatRows = "";
                recentChats.slice(0, 4).forEach(c => {
                    const cText = escapeHtml(c.comment || "");
                    const cStreamer = escapeHtml(c.streamer_display_name || c.streamer_username || "");
                    const cTime = c.created_at ? getRelativeTime(c.created_at) : "";
                    chatRows += `
                        <div style="font-size: 11px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; gap: 2px;">
                            <div style="color: var(--text-main); line-height: 1.35;">💬 "${cText}"</div>
                            <div class="muted" style="font-size: 9.5px;">bei @${cStreamer} · ${cTime}</div>
                        </div>
                    `;
                });
                chatHtml = `
                    <div style="margin-bottom: 14px;">
                        <div class="ma-dossier-section-title">
                            <span>Letzte Chat-Nachrichten</span>
                            <span class="muted mono" style="font-size: 10px;">${recentChats.length}</span>
                        </div>
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 10px; max-height: 130px; overflow-y: auto;">
                            ${chatRows}
                        </div>
                    </div>
                `;
            }

            // 5. Quick Tag choices
            const availableQuickTags = ["whale", "loyal", "sniper", "chatter", "mod", "sponsor"];
            let tagsHtml = "";
            availableQuickTags.forEach(t => {
                const hasTag = tags.includes(t);
                tagsHtml += `
                    <div class="ma-crm-tag-chip ${hasTag ? 'active' : ''}" data-tag="${t}">
                        #${t} ${hasTag ? '✓' : '+'}
                    </div>
                `;
            });
            tags.forEach(t => {
                if (!availableQuickTags.includes(t)) {
                    tagsHtml += `
                        <div class="ma-crm-tag-chip active" data-tag="${escapeHtml(t)}">
                            #${escapeHtml(t)} ✓
                        </div>
                    `;
                }
            });

            elements.dossierBody.innerHTML = `
                <!-- Profile Hero -->
                <div class="ma-dossier-hero">
                    <img src="${escapeHtml(avatar)}" class="ma-dossier-avatar" onerror="this.src='/static/avatar_default.png'" />
                    <div style="flex: 1; min-width: 0;">
                        <div class="ma-dossier-title">
                            <span>@${escapeHtml(finalUsername)}</span>
                            <button type="button" class="ma-vip-star-btn ${isVip ? 'is-vip' : ''}" id="maModalVipBtn" style="font-size: 18px;" title="VIP Status umschalten">
                                ⭐
                            </button>
                        </div>
                        ${displayNick ? `<div class="ma-dossier-nick">${displayNick}</div>` : ""}
                        <div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
                            ${profile.is_cross_streamer ? '<span class="ma-cross-tag">⚡ Multi-Streamer Spender</span>' : ''}
                        </div>
                    </div>
                </div>

                <!-- Loyalty Box -->
                ${loyaltyHtml}

                <!-- KPI Grid -->
                <div class="ma-dossier-kpi-grid">
                    <div class="ma-dossier-kpi-box">
                        <span class="ma-dossier-kpi-lbl">Gesamt-Spenden</span>
                        <span class="ma-dossier-kpi-val" style="color: #fbbf24;">💎 ${coins}</span>
                    </div>
                    <div class="ma-dossier-kpi-box">
                        <span class="ma-dossier-kpi-lbl">Netto (EUR)</span>
                        <span class="ma-dossier-kpi-val" style="color: #10b981;">+${eurNet}</span>
                    </div>
                    <div class="ma-dossier-kpi-box">
                        <span class="ma-dossier-kpi-lbl">Geschenke-Anzahl</span>
                        <span class="ma-dossier-kpi-val">${giftsCount}</span>
                    </div>
                    <div class="ma-dossier-kpi-box">
                        <span class="ma-dossier-kpi-lbl">Zuletzt gesehen</span>
                        <span class="ma-dossier-kpi-val" style="font-size: 11px; font-weight: 700; color: var(--text-muted);">
                            ${profile.last_seen ? getRelativeTime(profile.last_seen) : '-'}
                        </span>
                    </div>
                </div>

                <!-- CRM & Notizen Section -->
                <div class="ma-dossier-crm-box">
                    <div class="ma-crm-header">
                        <span class="ma-crm-title">⭐ Spender-CRM &amp; Tags</span>
                        <span class="muted" style="font-size: 10px;">Tap auf Tag zum Umschalten</span>
                    </div>
                    <div class="ma-crm-tags-wrap" id="maDossierTagsWrap">
                        ${tagsHtml}
                    </div>
                    <div style="margin-top: 8px;">
                        <label style="font-size: 10.5px; font-weight: 700; color: var(--text-muted);">Private Spender-Notizen:</label>
                        <textarea id="maDossierNotesInput" class="ma-crm-notes-input" placeholder="Wichtige Infos zu diesem Großspender notieren...">${escapeHtml(notes)}</textarea>
                    </div>
                    <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
                        <button type="button" class="ma-btn ma-btn-primary" id="maBtnSaveDossierNotes" style="font-size: 11px; padding: 5px 12px;">
                            💾 Notiz speichern
                        </button>
                    </div>
                </div>

                <!-- Streamer Verteilung -->
                <div style="margin-bottom: 14px;">
                    <div class="ma-dossier-section-title">
                        <span>Beschenkte Streamer</span>
                        <span class="muted mono" style="font-size: 10.5px;">${streamers.length} Kanäle</span>
                    </div>
                    <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 10px;">
                        ${sHtml || '<div class="muted">Keine Streamer-Zuordnung verfügbar.</div>'}
                    </div>
                </div>

                <!-- Top Geschenke -->
                <div style="margin-bottom: 14px;">
                    <div class="ma-dossier-section-title">
                        <span>Lieblings-Geschenke</span>
                    </div>
                    <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                        ${gHtml || '<div class="muted">Keine Geschenk-Daten verfügbar.</div>'}
                    </div>
                </div>

                <!-- Chat Activity -->
                ${chatHtml}
            `;

            // VIP Star Toggle inside modal
            const modalVipBtn = document.getElementById("maModalVipBtn");
            if (modalVipBtn) {
                modalVipBtn.addEventListener("click", () => {
                    toggleDonorVip(finalUsername, modalVipBtn);
                });
            }

            // Quick Tag click handlers
            const tagsWrap = document.getElementById("maDossierTagsWrap");
            if (tagsWrap) {
                tagsWrap.querySelectorAll(".ma-crm-tag-chip").forEach(chip => {
                    chip.addEventListener("click", async () => {
                        triggerHaptic("light");
                        const tag = chip.getAttribute("data-tag");
                        let activeTags = Array.isArray(currentDossierData.tags) ? [...currentDossierData.tags] : [];
                        if (activeTags.includes(tag)) {
                            activeTags = activeTags.filter(t => t !== tag);
                            chip.classList.remove("active");
                            chip.textContent = `#${tag} +`;
                        } else {
                            activeTags.push(tag);
                            chip.classList.add("active");
                            chip.textContent = `#${tag} ✓`;
                        }
                        currentDossierData.tags = activeTags;
                        const notesVal = document.getElementById("maDossierNotesInput")?.value || "";
                        await saveDonorCRM(finalUsername, currentDossierData.is_vip, activeTags, notesVal, true);
                    });
                });
            }

            // Save Notes Button
            const btnSaveNotes = document.getElementById("maBtnSaveDossierNotes");
            if (btnSaveNotes) {
                btnSaveNotes.addEventListener("click", async () => {
                    triggerHaptic("medium");
                    const notesVal = document.getElementById("maDossierNotesInput")?.value || "";
                    btnSaveNotes.disabled = true;
                    btnSaveNotes.textContent = "⏳...";
                    const success = await saveDonorCRM(finalUsername, currentDossierData.is_vip, currentDossierData.tags || [], notesVal);
                    btnSaveNotes.disabled = false;
                    btnSaveNotes.textContent = "💾 Notiz speichern";
                    if (success) {
                        showToast(`Notizen für @${finalUsername} gespeichert!`);
                    }
                });
            }

        } catch (e) {
            console.error("Dossier Fetch Error:", e);
            elements.dossierBody.innerHTML = `
                <div class="ma-empty-state">
                    <div class="ma-empty-icon">⚠️</div>
                    <div>Fehler beim Laden des Spender-Dossiers</div>
                </div>
            `;
        }
    }

    // 6. VIP Toggle Action
    async function toggleDonorVip(username, starEl, event) {
        if (event) event.stopPropagation();
        triggerHaptic("medium");

        try {
            const res = await fetch(`/api/donor-radar/donors/${encodeURIComponent(username)}/toggle-vip`, {
                method: "POST",
                headers: getAuthHeaders(),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const isVip = !!(json.data && json.data.is_vip);

            if (starEl) {
                starEl.classList.toggle("is-vip", isVip);
            }
            const modalStar = document.getElementById("maModalVipBtn");
            if (modalStar) {
                modalStar.classList.toggle("is-vip", isVip);
            }
            if (currentDossierData && currentDossierData.username === username) {
                currentDossierData.is_vip = isVip;
            }

            // Sync with any visible donor cards
            if (elements.radarDonorsContainer) {
                const card = elements.radarDonorsContainer.querySelector(`[data-donor-username="${username}"]`);
                if (card) {
                    const cardStar = card.querySelector("[data-action='toggle-vip']");
                    if (cardStar) cardStar.classList.toggle("is-vip", isVip);
                }
            }

            showToast(isVip ? `⭐ @${username} zur VIP-Watchlist hinzugefügt!` : `@${username} von VIP-Watchlist entfernt.`);
            // Update KPI count
            fetchRadarData(true);
        } catch (e) {
            console.error("Toggle VIP Error:", e);
            showToast("Fehler beim Umschalten des VIP-Status", "error");
        }
    }

    // 7. Save CRM Data Action
    async function saveDonorCRM(username, isVip, tags, notes, silent = false) {
        try {
            const res = await fetch(`/api/donor-radar/donors/${encodeURIComponent(username)}/crm`, {
                method: "POST",
                headers: Object.assign({ "Content-Type": "application/json" }, getAuthHeaders()),
                body: JSON.stringify({
                    is_vip: !!isVip,
                    tags: tags || [],
                    notes: notes || "",
                }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (silent) triggerHaptic("light");
            return true;
        } catch (e) {
            console.error("Save CRM Error:", e);
            if (!silent) showToast("Fehler beim Speichern der Notizen", "error");
            return false;
        }
    }

    // 8. Sub-Tab Switcher for Radar
    function switchRadarSubTab(subtab) {
        if (subtab === radarSubTab) return;
        triggerHaptic("light");
        radarSubTab = subtab;

        if (elements.subTabDonors) elements.subTabDonors.classList.toggle("active", subtab === "donors");
        if (elements.subTabAlerts) elements.subTabAlerts.classList.toggle("active", subtab === "alerts");
        if (elements.subTabLoyalty) elements.subTabLoyalty.classList.toggle("active", subtab === "loyalty");

        if (elements.subViewDonors) elements.subViewDonors.style.display = subtab === "donors" ? "block" : "none";
        if (elements.subViewAlerts) elements.subViewAlerts.style.display = subtab === "alerts" ? "block" : "none";
        if (elements.subViewLoyalty) elements.subViewLoyalty.style.display = subtab === "loyalty" ? "block" : "none";

        if (subtab === "donors") {
            fetchRadarData();
        } else if (subtab === "alerts") {
            fetchWhaleAlerts();
        } else if (subtab === "loyalty") {
            fetchLoyaltyData();
        }
    }

    // =====================================================================
    // 5. ADMIN CONTROL PANEL
    // =====================================================================
    async function loadAdminData() {
        if (!isAdmin) return;
        renderAdminStreamers(cachedStreamers);
        fetchSystemStatus();
    }

    function renderAdminStreamers(streamers) {
        if (!elements.adminStreamersContainer) return;
        if (!streamers || streamers.length === 0) {
            elements.adminStreamersContainer.innerHTML = '<div class="ma-empty-state">Keine Streamer vorhanden.</div>';
            return;
        }

        let html = "";
        streamers.forEach(s => {
            const avatar = s.avatar_url || "/static/avatar_default.png";
            const name = s.display_name || s.username;
            const uname = s.username;
            const isTracking = !!s.is_tracking;
            const isLive = !!s.is_live;

            html += `
                <div class="ma-admin-streamer-card">
                    <div class="ma-admin-streamer-top">
                        <div class="ma-admin-streamer-meta">
                            <img src="${escapeHtml(avatar)}" class="ma-admin-streamer-avatar" onerror="this.src='/static/avatar_default.png'">
                            <div>
                                <div class="ma-admin-streamer-title">${escapeHtml(name)} ${isLive ? '🟢' : '⚪'}</div>
                                <div class="ma-admin-streamer-sub">@${escapeHtml(uname)}</div>
                            </div>
                        </div>
                        <div>
                            <button type="button" class="ma-btn-toggle ${isTracking ? 'active' : ''}" data-action="toggle-track" data-username="${escapeHtml(uname)}">
                                ${isTracking ? '● TRACKING' : '○ PAUSIERT'}
                            </button>
                        </div>
                    </div>
                    <div class="ma-admin-streamer-actions">
                        <button type="button" class="ma-btn ma-btn-secondary" style="font-size: 10px; padding: 4px 8px;" data-action="refresh" data-username="${escapeHtml(uname)}">
                            🔄 Sync
                        </button>
                        <button type="button" class="ma-btn ma-btn-danger" style="font-size: 10px; padding: 4px 8px;" data-action="delete" data-username="${escapeHtml(uname)}" data-id="${s.id}">
                            🗑️ Löschen
                        </button>
                    </div>
                </div>
            `;
        });
        elements.adminStreamersContainer.innerHTML = html;

        // Attach action handlers
        elements.adminStreamersContainer.querySelectorAll("[data-action]").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const action = btn.getAttribute("data-action");
                const username = btn.getAttribute("data-username");
                const streamerId = btn.getAttribute("data-id");

                if (action === "toggle-track") {
                    triggerHaptic("medium");
                    try {
                        const res = await fetch(`/api/streamers/${encodeURIComponent(username)}/track`, {
                            method: "POST",
                            headers: Object.assign({ "Content-Type": "application/json" }, getAuthHeaders()),
                            body: JSON.stringify({ action: "toggle", auto_reconnect: true })
                        });
                        if (res.ok) {
                            showToast(`Tracking für @${username} umgeschaltet!`);
                            fetchMiniAppData();
                        } else {
                            showToast("Fehler beim Umschalten", "error");
                        }
                    } catch (err) {
                        showToast("Netzwerkfehler", "error");
                    }
                } else if (action === "refresh") {
                    triggerHaptic("light");
                    btn.textContent = "⏳...";
                    try {
                        const res = await fetch(`/api/streamers/${encodeURIComponent(username)}/refresh`, {
                            method: "POST",
                            headers: getAuthHeaders()
                        });
                        if (res.ok) {
                            showToast(`Profil @${username} aktualisiert!`);
                            fetchMiniAppData();
                        } else {
                            showToast("Sync fehlgeschlagen", "error");
                        }
                    } catch (err) {
                        showToast("Netzwerkfehler", "error");
                    }
                } else if (action === "delete") {
                    triggerHaptic("warning");
                    if (confirm(`Streamer @${username} wirklich komplett aus dem TokTracker löschen?`)) {
                        try {
                            const res = await fetch(`/api/streamers/${encodeURIComponent(streamerId || username)}`, {
                                method: "DELETE",
                                headers: getAuthHeaders()
                            });
                            if (res.ok) {
                                showToast(`Streamer @${username} gelöscht.`);
                                fetchMiniAppData();
                            } else {
                                showToast("Löschen fehlgeschlagen", "error");
                            }
                        } catch (err) {
                            showToast("Netzwerkfehler", "error");
                        }
                    }
                }
            });
        });
    }

    async function fetchSystemStatus(forceRefresh = false) {
        if (elements.btnMaRefreshHealth) {
            elements.btnMaRefreshHealth.disabled = true;
            elements.btnMaRefreshHealth.textContent = "⏳ Lade...";
        }
        try {
            const url = forceRefresh ? "/api/system/health?force_refresh=true" : "/api/system/status";
            const res = await fetch(url, {
                headers: getAuthHeaders()
            });
            if (!res.ok) return;
            const data = await res.json();

            // When calling /api/system/health directly, the payload is the health object itself
            const health = data.system_health || (data.host ? data : null);

            if (elements.diagDbEngine && (data.db_engine || health?.database?.engine)) {
                elements.diagDbEngine.textContent = data.db_engine || health?.database?.engine || "mariadb";
            }
            if (elements.diagActiveWorkers && data.total_streamers !== undefined) {
                const total = data.total_streamers || 0;
                const active = data.active_workers || 0;
                elements.diagActiveWorkers.textContent = `${active} von ${total} aktiv`;
            }
            if (elements.diagBotStatus && data.telegram_bot) {
                const b = data.telegram_bot || {};
                elements.diagBotStatus.textContent = `${b.state || 'ok'} (${b.username || '@toktrackeragent'})`;
            }
            if (elements.diagTiktokSession && data.has_tiktok_session !== undefined) {
                elements.diagTiktokSession.textContent = data.has_tiktok_session ? "✅ Aktiv" : "⚪ Keine Session";
            }

            if (health) {
                renderMiniAppHealth(health);
            }
        } catch (e) {
            console.error("Fehler beim Abrufen des System-Status:", e);
        } finally {
            if (elements.btnMaRefreshHealth) {
                elements.btnMaRefreshHealth.disabled = false;
                elements.btnMaRefreshHealth.textContent = "🔄 Aktualisieren";
            }
        }
    }

    function renderMiniAppHealth(health) {
        if (!health) return;
        const host = health.host || {};
        const disk = host.disk || {};
        const mem = host.memory || {};
        const cpu = host.cpu || {};
        const docker = health.docker || {};
        const db = health.database || {};

        const fmtMbOrGb = (mb) => {
            if (!mb && mb !== 0) return "--";
            return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
        };

        // 1. Host Status Badge
        if (elements.healthStatusBadge) {
            const isCrit = disk.status === "critical" || mem.status === "critical" || cpu.status === "critical";
            const isWarn = disk.status === "warning" || mem.status === "warning" || cpu.status === "warning";
            if (isCrit) {
                elements.healthStatusBadge.textContent = "KRITISCH";
                elements.healthStatusBadge.className = "status-pill danger";
            } else if (isWarn) {
                elements.healthStatusBadge.textContent = "WARNUNG";
                elements.healthStatusBadge.className = "status-pill warning";
            } else {
                elements.healthStatusBadge.textContent = "OPTIMAL";
                elements.healthStatusBadge.className = "status-pill live";
            }
        }

        // 2. Festplatte
        const diskPct = typeof disk.percent === "number" ? disk.percent : 0;
        if (elements.healthDiskPercent) {
            elements.healthDiskPercent.textContent = `${diskPct.toFixed(1)}%`;
            if (disk.status === "critical" || diskPct >= 85) elements.healthDiskPercent.style.color = "#ef4444";
            else if (disk.status === "warning" || diskPct >= 75) elements.healthDiskPercent.style.color = "#f59e0b";
            else elements.healthDiskPercent.style.color = "#10b981";
        }
        if (elements.healthDiskBar) {
            elements.healthDiskBar.style.width = `${Math.min(diskPct, 100)}%`;
            if (disk.status === "critical" || diskPct >= 85) elements.healthDiskBar.style.background = "#ef4444";
            else if (disk.status === "warning" || diskPct >= 75) elements.healthDiskBar.style.background = "#f59e0b";
            else elements.healthDiskBar.style.background = "#10b981";
        }
        if (elements.healthDiskUsed) elements.healthDiskUsed.textContent = `${disk.used_gb || 0} GB`;
        if (elements.healthDiskFree) elements.healthDiskFree.textContent = `${disk.free_gb || 0} GB`;
        if (elements.healthDiskTotal) elements.healthDiskTotal.textContent = `${disk.total_gb || 0} GB`;

        // 3. RAM
        const memPct = typeof mem.percent === "number" ? mem.percent : 0;
        if (elements.healthRamPercent) {
            elements.healthRamPercent.textContent = `${memPct.toFixed(1)}%`;
            if (memPct >= 90) elements.healthRamPercent.style.color = "#ef4444";
            else if (memPct >= 75) elements.healthRamPercent.style.color = "#f59e0b";
            else elements.healthRamPercent.style.color = "#3b82f6";
        }
        if (elements.healthRamBar) {
            elements.healthRamBar.style.width = `${Math.min(memPct, 100)}%`;
            if (memPct >= 90) elements.healthRamBar.style.background = "#ef4444";
            else if (memPct >= 75) elements.healthRamBar.style.background = "#f59e0b";
            else elements.healthRamBar.style.background = "#3b82f6";
        }
        if (elements.healthRamUsed) elements.healthRamUsed.textContent = fmtMbOrGb(mem.used_mb);
        if (elements.healthRamFree) elements.healthRamFree.textContent = fmtMbOrGb(mem.free_mb);
        if (elements.healthRamTotal) elements.healthRamTotal.textContent = fmtMbOrGb(mem.total_mb);

        // 4. CPU & Load
        const cpuPct = typeof cpu.percent === "number" ? cpu.percent : 0;
        if (elements.healthCpuPercent) {
            elements.healthCpuPercent.textContent = `${cpuPct.toFixed(1)}%`;
            if (cpuPct >= 85) elements.healthCpuPercent.style.color = "#ef4444";
            else if (cpuPct >= 65) elements.healthCpuPercent.style.color = "#f59e0b";
            else elements.healthCpuPercent.style.color = "#8b5cf6";
        }
        if (elements.healthCpuBar) {
            elements.healthCpuBar.style.width = `${Math.min(cpuPct, 100)}%`;
            if (cpuPct >= 85) elements.healthCpuBar.style.background = "#ef4444";
            else if (cpuPct >= 65) elements.healthCpuBar.style.background = "#f59e0b";
            else elements.healthCpuBar.style.background = "#8b5cf6";
        }
        if (elements.healthCpuLoad) {
            const l1 = typeof cpu.load_1m === "number" ? cpu.load_1m.toFixed(2) : "-";
            const l5 = typeof cpu.load_5m === "number" ? cpu.load_5m.toFixed(2) : "-";
            elements.healthCpuLoad.textContent = `${l1} / ${l5}`;
        }
        if (elements.healthCpuCores) elements.healthCpuCores.textContent = `${cpu.cpu_count || 1}`;

        // 5. Docker Connection Badge
        if (elements.dockerConnBadge) {
            if (docker.available) {
                const count = (docker.containers || []).length;
                const running = (docker.containers || []).filter(c => c.state === "running").length;
                elements.dockerConnBadge.textContent = `${running}/${count} aktiv`;
                elements.dockerConnBadge.className = "status-pill live";
            } else {
                elements.dockerConnBadge.textContent = "Host-Only";
                elements.dockerConnBadge.className = "status-pill";
            }
        }

        // 6. Docker Container Items
        if (elements.containersList) {
            const containers = docker.containers || [];
            if (!docker.available) {
                elements.containersList.innerHTML = `<div class="muted" style="font-size:10.5px;">Docker Socket nicht angebunden. Host-Ressourcen werden direkt über OS erfasst.</div>`;
            } else if (containers.length === 0) {
                elements.containersList.innerHTML = `<div class="muted" style="font-size:10.5px;">Keine Container gefunden.</div>`;
            } else {
                elements.containersList.innerHTML = containers.map(c => {
                    const isRunning = c.state === "running";
                    const cpuStr = typeof c.cpu_percent === "number" ? `${c.cpu_percent.toFixed(1)}%` : "--";
                    const ramUsed = c.memory ? c.memory.used_mb : 0;
                    const ramPct = c.memory ? c.memory.percent.toFixed(0) + '%' : '--';
                    const rwSize = c.size_rw_mb !== undefined && c.size_rw_mb !== null ? `${c.size_rw_mb} MB` : "--";

                    return `
                        <div class="ma-container-item">
                            <div class="ma-container-top">
                                <div class="ma-container-name">
                                    <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${isRunning ? '#10b981' : '#ef4444'};"></span>
                                    <span>${escapeHtml(c.name)}</span>
                                </div>
                                <div style="display:flex;align-items:center;gap:6px;">
                                    <span class="mono" style="font-size:10px;font-weight:700;">${cpuStr}</span>
                                    <span class="status-pill ${isRunning ? 'live' : 'danger'}" style="font-size:9px;padding:1px 5px;">${escapeHtml(c.status || c.state)}</span>
                                </div>
                            </div>
                            <div class="ma-container-bottom">
                                <span>RAM: <strong>${ramUsed} MB</strong> (${ramPct})</span>
                                <span>Layer: <strong style="color:#38bdf8;">${rwSize}</strong></span>
                            </div>
                        </div>
                    `;
                }).join("");
            }
        }

        // 7. Volumes Summary
        if (elements.volumesSummary) {
            const vols = docker.volumes || [];
            if (vols.length === 0) {
                elements.volumesSummary.textContent = "Keine Daten";
            } else {
                elements.volumesSummary.textContent = vols.map(v => {
                    const sz = v.size_mb > 0 ? `${v.size_mb} MB` : "aktiv";
                    return `${v.name} (${sz})`;
                }).join(" · ");
            }
        }

        // 8. Database Summary
        if (elements.dbSummary) {
            const totalMb = db.total_mb || 0;
            const engine = (db.engine || 'MySQL').toUpperCase();
            elements.dbSummary.textContent = `${totalMb} MB (${engine} · ${(db.tables || []).length} Tabellen)`;
        }
    }

    if (elements.btnMaRefreshHealth) {
        elements.btnMaRefreshHealth.addEventListener("click", () => {
            triggerHaptic("light");
            fetchSystemStatus(true).then(() => {
                showToast("System-Status aktualisiert");
            });
        });
    }

    // Modal Submissions
    // 1. Add Streamer
    if (elements.btnSubmitAddStreamer) {
        elements.btnSubmitAddStreamer.addEventListener("click", async () => {
            const uname = (elements.inputAddStreamerUsername.value || "").trim().replace(/^@/, "");
            if (!uname) {
                showToast("Bitte Username eingeben", "error");
                return;
            }
            triggerHaptic("medium");
            elements.btnSubmitAddStreamer.disabled = true;
            try {
                const res = await fetch("/api/streamers", {
                    method: "POST",
                    headers: Object.assign({ "Content-Type": "application/json" }, getAuthHeaders()),
                    body: JSON.stringify({
                        username: uname,
                        display_name: (elements.inputAddStreamerDisplayName.value || "").trim() || null,
                        auto_track: elements.checkAddStreamerAutoTrack.checked,
                        auto_reconnect: elements.checkAddStreamerAutoReconnect.checked
                    })
                });
                if (res.ok) {
                    showToast(`Streamer @${uname} erfolgreich angelegt!`);
                    elements.inputAddStreamerUsername.value = "";
                    elements.inputAddStreamerDisplayName.value = "";
                    closeModal(elements.modalAddStreamer);
                    fetchMiniAppData();
                } else {
                    const err = await res.json();
                    showToast(err.detail || "Fehler beim Anlegen", "error");
                }
            } catch (err) {
                showToast("Netzwerkfehler", "error");
            } finally {
                elements.btnSubmitAddStreamer.disabled = false;
            }
        });
    }

    // 2. Add Gift
    if (elements.btnSubmitAddGift) {
        elements.btnSubmitAddGift.addEventListener("click", async () => {
            const streamerId = parseInt(elements.selectAddGiftStreamer.value, 10);
            const giftName = (elements.inputAddGiftName.value || "").trim();
            const diamonds = parseInt(elements.inputAddGiftCoins.value, 10) || 1;
            const count = parseInt(elements.inputAddGiftCount.value, 10) || 1;
            const sender = (elements.inputAddGiftSender.value || "").trim() || "manual_admin";

            if (!streamerId || !giftName) {
                showToast("Bitte Streamer und Gift-Name angeben", "error");
                return;
            }
            triggerHaptic("medium");
            elements.btnSubmitAddGift.disabled = true;
            try {
                const res = await fetch("/api/gifts", {
                    method: "POST",
                    headers: Object.assign({ "Content-Type": "application/json" }, getAuthHeaders()),
                    body: JSON.stringify({
                        streamer_id: streamerId,
                        gift_name: giftName,
                        diamond_count: diamonds,
                        repeat_count: count,
                        sender_username: sender,
                        source: "manual_miniapp"
                    })
                });
                if (res.ok) {
                    showToast(`Geschenk ${count}x ${giftName} erfolgreich gebucht!`);
                    closeModal(elements.modalAddGift);
                    fetchMiniAppData();
                } else {
                    showToast("Fehler beim Buchen", "error");
                }
            } catch (err) {
                showToast("Netzwerkfehler", "error");
            } finally {
                elements.btnSubmitAddGift.disabled = false;
            }
        });
    }

    // 3. Settings Modal
    async function loadSettings() {
        try {
            const res = await fetch("/api/settings", { headers: getAuthHeaders() });
            if (!res.ok) return;
            const s = await res.json();
            if (elements.inputSettingsUsdDiamond) elements.inputSettingsUsdDiamond.value = s.usd_per_diamond || 0.005;
            if (elements.inputSettingsGrossCoin) elements.inputSettingsGrossCoin.value = s.gross_usd_per_coin || 0.0106;
            if (elements.inputSettingsUsdToEur) elements.inputSettingsUsdToEur.value = s.usd_to_eur_rate || 0.92;
            if (elements.selectSettingsCurrency) elements.selectSettingsCurrency.value = s.currency_primary || "EUR";
            if (elements.selectSettingsTgMode) elements.selectSettingsTgMode.value = s.telegram_access_mode || "whitelist";
        } catch (e) {}
    }

    if (elements.btnSubmitSettings) {
        elements.btnSubmitSettings.addEventListener("click", async () => {
            triggerHaptic("medium");
            try {
                const payload = {
                    usd_per_diamond: parseFloat(elements.inputSettingsUsdDiamond.value),
                    gross_usd_per_coin: parseFloat(elements.inputSettingsGrossCoin.value),
                    usd_to_eur_rate: parseFloat(elements.inputSettingsUsdToEur.value),
                    currency_primary: elements.selectSettingsCurrency.value,
                    telegram_access_mode: elements.selectSettingsTgMode.value
                };
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: Object.assign({ "Content-Type": "application/json" }, getAuthHeaders()),
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    showToast("Einstellungen gespeichert!");
                    closeModal(elements.modalSettings);
                    fetchMiniAppData();
                } else {
                    showToast("Fehler beim Speichern", "error");
                }
            } catch (err) {
                showToast("Netzwerkfehler", "error");
            }
        });
    }

    // 4. Whitelist Modal
    async function loadWhitelist() {
        if (!elements.whitelistUsersContainer) return;
        try {
            const res = await fetch("/api/telegram/users", { headers: getAuthHeaders() });
            if (!res.ok) return;
            const users = await res.json();

            let html = "";
            users.forEach(u => {
                const uname = u.username ? `@${u.username}` : (u.telegram_id || "Unbekannt");
                const isAllowed = parseInt(u.is_allowed, 10) === 1;
                const isAdminRole = u.role === "admin";
                const badge = isAllowed ? (isAdminRole ? "👑 Admin" : "🟢 User") : "🔴 Gesperrt";

                html += `
                    <div class="ma-whitelist-item">
                        <div>
                            <div style="font-weight: 700; color: var(--text-strong);">${escapeHtml(uname)}</div>
                            <div style="font-size: 9px; color: var(--text-muted);">${badge} · ID: ${u.telegram_id || '-'}</div>
                        </div>
                        <div class="ma-whitelist-actions">
                            <button type="button" class="ma-btn ma-btn-secondary" style="font-size: 9px; padding: 2px 6px;" data-toggle-role="${u.id}" data-role="${isAdminRole ? 'user' : 'admin'}" data-ident="${u.telegram_id || u.username}">
                                ${isAdminRole ? 'User machen' : 'Admin machen'}
                            </button>
                            <button type="button" class="ma-btn ${isAllowed ? 'ma-btn-danger' : 'ma-btn-primary'}" style="font-size: 9px; padding: 2px 6px;" data-toggle-allow="${u.id}" data-allowed="${isAllowed ? 0 : 1}" data-ident="${u.telegram_id || u.username}">
                                ${isAllowed ? 'Sperren' : 'Erlauben'}
                            </button>
                        </div>
                    </div>
                `;
            });
            elements.whitelistUsersContainer.innerHTML = html;

            elements.whitelistUsersContainer.querySelectorAll("[data-toggle-role]").forEach(b => {
                b.addEventListener("click", async () => {
                    const ident = b.getAttribute("data-ident");
                    const newRole = b.getAttribute("data-role");
                    await updateTelegramUserPermission(ident, 1, newRole);
                });
            });

            elements.whitelistUsersContainer.querySelectorAll("[data-toggle-allow]").forEach(b => {
                b.addEventListener("click", async () => {
                    const ident = b.getAttribute("data-ident");
                    const newAllow = parseInt(b.getAttribute("data-allowed"), 10);
                    await updateTelegramUserPermission(ident, newAllow, "user");
                });
            });
        } catch (e) {
            elements.whitelistUsersContainer.innerHTML = '<div class="ma-empty-state">Fehler beim Laden.</div>';
        }
    }

    async function updateTelegramUserPermission(ident, isAllowed, role) {
        triggerHaptic("medium");
        try {
            const res = await fetch("/api/telegram/users/permissions", {
                method: "POST",
                headers: Object.assign({ "Content-Type": "application/json" }, getAuthHeaders()),
                body: JSON.stringify({ identifier: String(ident), is_allowed: isAllowed, role: role })
            });
            if (res.ok) {
                showToast("Nutzerrechte aktualisiert!");
                loadWhitelist();
            } else {
                showToast("Fehler bei Rechteänderung", "error");
            }
        } catch (e) {
            showToast("Netzwerkfehler", "error");
        }
    }

    if (elements.btnSubmitAddTgUser) {
        elements.btnSubmitAddTgUser.addEventListener("click", async () => {
            const ident = (elements.inputAddTgUserIdent.value || "").trim();
            const role = elements.selectAddTgUserRole.value;
            if (!ident) return;
            await updateTelegramUserPermission(ident, 1, role);
            elements.inputAddTgUserIdent.value = "";
        });
    }

    // Modal Trigger Buttons
    if (elements.btnOpenAddStreamer) elements.btnOpenAddStreamer.addEventListener("click", () => openModal(elements.modalAddStreamer));
    if (elements.btnOpenAddGift) elements.btnOpenAddGift.addEventListener("click", () => openModal(elements.modalAddGift));
    if (elements.btnOpenSettings) elements.btnOpenSettings.addEventListener("click", () => { openModal(elements.modalSettings); loadSettings(); });
    if (elements.btnOpenWhitelist) elements.btnOpenWhitelist.addEventListener("click", () => { openModal(elements.modalWhitelist); loadWhitelist(); });

    // Modal Close Buttons
    document.querySelectorAll(".ma-sheet-close, [data-close]").forEach(btn => {
        btn.addEventListener("click", () => {
            const target = btn.closest(".ma-modal-backdrop");
            if (target) closeModal(target);
        });
    });

    document.querySelectorAll(".ma-modal-backdrop").forEach(backdrop => {
        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) closeModal(backdrop);
        });
    });

    // OTP Auth Fallback Handlers
    if (elements.btnRequestOtp) {
        elements.btnRequestOtp.addEventListener("click", async () => {
            triggerHaptic("medium");
            elements.btnRequestOtp.disabled = true;
            try {
                const res = await fetch("/api/miniapp/auth/request_otp", { method: "POST" });
                if (res.ok) {
                    showToast("Code an hinterlegte Admins in Telegram gesendet!", "success");
                } else {
                    showToast("Fehler beim Code-Versand", "error");
                }
            } catch (e) {
                showToast("Netzwerkfehler", "error");
            } finally {
                elements.btnRequestOtp.disabled = false;
            }
        });
    }

    if (elements.btnSubmitOtp) {
        elements.btnSubmitOtp.addEventListener("click", async () => {
            const code = (elements.otpCodeInput.value || "").trim();
            if (!code) {
                showToast("Bitte Code eingeben", "error");
                return;
            }
            triggerHaptic("heavy");
            elements.btnSubmitOtp.disabled = true;
            try {
                const res = await fetch("/api/miniapp/auth/verify_otp", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code: code })
                });
                if (res.ok) {
                    const data = await res.json();
                    sessionToken = data.token;
                    localStorage.setItem("toktracker_admin_token", sessionToken);
                    isAdmin = true;
                    isWhitelisted = true;
                    authUser = { username: data.admin_label };
                    showToast("Erfolgreich als Admin angemeldet!");
                    elements.otpCodeInput.value = "";
                    updateAdminUI();
                    updateRadarAuthUI();
                } else {
                    showToast("Ungültiger oder abgelaufener Code", "error");
                }
            } catch (e) {
                showToast("Netzwerkfehler", "error");
            } finally {
                elements.btnSubmitOtp.disabled = false;
            }
        });
    }

    if (elements.btnAdminLogout) {
        elements.btnAdminLogout.addEventListener("click", async () => {
            triggerHaptic("medium");
            try {
                await fetch("/api/miniapp/auth/logout", { method: "POST" });
            } catch (e) {}
            sessionToken = "";
            localStorage.removeItem("toktracker_admin_token");
            isAdmin = false;
            isWhitelisted = false;
            showToast("Erfolgreich abgemeldet");
            updateAdminUI();
            updateRadarAuthUI();
        });
    }

    // =====================================================================
    // 6. EVENT HANDLERS & NAVIGATION
    // =====================================================================
    // Period Pills
    elements.periodPills.forEach(pill => {
        pill.addEventListener("click", () => {
            const period = pill.getAttribute("data-period");
            if (period === currentPeriod) return;
            triggerHaptic("light");
            currentPeriod = period;
            elements.periodPills.forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            lastAnalyticsFingerprint = null;
            fetchMiniAppData();
            if (activeTab === "tab-analytics") {
                fetchAnalyticsData();
            } else if (activeTab === "tab-radar") {
                fetchRadarData();
            }
        });
    });

    // Navigation Tabs
    elements.navTabs.forEach(btn => {
        btn.addEventListener("click", () => {
            const targetTab = btn.getAttribute("data-tab");
            if (targetTab === activeTab) return;
            triggerHaptic("medium");
            activeTab = targetTab;

            elements.navTabs.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");

            elements.tabViews.forEach(view => {
                if (view.id === targetTab) {
                    view.classList.add("active");
                } else {
                    view.classList.remove("active");
                }
            });

            if (targetTab === "tab-analytics") {
                stopRadarPolling();
                if (!analyticsLoadedOnce) {
                    analyticsLoadedOnce = true;
                    setTimeout(() => {
                        fetchAnalyticsData();
                    }, 50);
                } else {
                    fetchAnalyticsData();
                }
            } else if (targetTab === "tab-radar") {
                fetchRadarData();
                fetchWhaleTicker(true);
                startRadarPolling();
                if (radarSubTab === "alerts") fetchWhaleAlerts();
                if (radarSubTab === "loyalty") fetchLoyaltyData();
            } else if (targetTab === "tab-admin") {
                stopRadarPolling();
                updateAdminUI();
            } else {
                stopRadarPolling();
            }
        });
    });

    // Analytics Streamer Dropdown
    if (elements.analyticsStreamerSelect) {
        elements.analyticsStreamerSelect.addEventListener("change", () => {
            selectedAnalyticsStreamer = elements.analyticsStreamerSelect.value;
            triggerHaptic("light");
            lastAnalyticsFingerprint = null;
            fetchAnalyticsData();
        });
    }

    // Analytics Metric Dropdown
    if (elements.metricSelect) {
        elements.metricSelect.addEventListener("change", () => {
            const metric = elements.metricSelect.value;
            if (metric === analyticsMetric) return;
            triggerHaptic("light");
            analyticsMetric = metric;
            if (elements.metricPills) {
                elements.metricPills.forEach(p => {
                    p.classList.toggle("active", p.getAttribute("data-metric") === metric);
                });
            }
            if (cachedAnalyticsData) renderTimelineChart();
        });
    }

    // Analytics Metric Selector Pills
    if (elements.metricPills) {
        elements.metricPills.forEach(pill => {
            pill.addEventListener("click", () => {
                const metric = pill.getAttribute("data-metric");
                if (metric === analyticsMetric) return;
                triggerHaptic("light");
                analyticsMetric = metric;
                elements.metricPills.forEach(p => p.classList.remove("active"));
                pill.classList.add("active");
                if (elements.metricSelect) {
                    elements.metricSelect.value = metric;
                }
                if (cachedAnalyticsData) renderTimelineChart();
            });
        });
    }

    // Analytics Chart Type Toggle (Line, Bar, Area)
    if (elements.btnChartLine) {
        elements.btnChartLine.addEventListener("click", () => {
            if (analyticsChartType === "line") return;
            triggerHaptic("light");
            analyticsChartType = "line";
            elements.btnChartLine.classList.add("active");
            if (elements.btnChartBar) elements.btnChartBar.classList.remove("active");
            if (elements.btnChartArea) elements.btnChartArea.classList.remove("active");
            if (cachedAnalyticsData) renderTimelineChart();
        });
    }
    if (elements.btnChartBar) {
        elements.btnChartBar.addEventListener("click", () => {
            if (analyticsChartType === "bar") return;
            triggerHaptic("light");
            analyticsChartType = "bar";
            elements.btnChartBar.classList.add("active");
            if (elements.btnChartLine) elements.btnChartLine.classList.remove("active");
            if (elements.btnChartArea) elements.btnChartArea.classList.remove("active");
            if (cachedAnalyticsData) renderTimelineChart();
        });
    }
    if (elements.btnChartArea) {
        elements.btnChartArea.addEventListener("click", () => {
            if (analyticsChartType === "area") return;
            triggerHaptic("light");
            analyticsChartType = "area";
            elements.btnChartArea.classList.add("active");
            if (elements.btnChartLine) elements.btnChartLine.classList.remove("active");
            if (elements.btnChartBar) elements.btnChartBar.classList.remove("active");
            if (cachedAnalyticsData) renderTimelineChart();
        });
    }

    // =====================================================================
    // RADAR FILTER CONTROLS (TIER PILLS, CROSS-ONLY, SEARCH)
    // =====================================================================
    if (elements.radarTierPills) {
        elements.radarTierPills.forEach(pill => {
            pill.addEventListener("click", () => {
                const tier = pill.getAttribute("data-tier");
                if (tier === radarTier) return;
                triggerHaptic("light");
                radarTier = tier;
                elements.radarTierPills.forEach(p => p.classList.remove("active"));
                pill.classList.add("active");
                fetchRadarData();
            });
        });
    }

    if (elements.btnToggleCrossOnly) {
        elements.btnToggleCrossOnly.addEventListener("click", () => {
            triggerHaptic("light");
            radarCrossOnly = !radarCrossOnly;
            elements.btnToggleCrossOnly.classList.toggle("active", radarCrossOnly);
            fetchRadarData();
        });
    }

    if (elements.btnToggleVipOnly) {
        elements.btnToggleVipOnly.addEventListener("click", () => {
            triggerHaptic("light");
            radarVipOnly = !radarVipOnly;
            elements.btnToggleVipOnly.classList.toggle("active", radarVipOnly);
            if (elements.cardKpiVip) {
                elements.cardKpiVip.classList.toggle("active-filter", radarVipOnly);
            }
            fetchRadarData();
        });
    }

    if (elements.cardKpiVip) {
        elements.cardKpiVip.addEventListener("click", () => {
            triggerHaptic("medium");
            radarVipOnly = !radarVipOnly;
            if (elements.btnToggleVipOnly) {
                elements.btnToggleVipOnly.classList.toggle("active", radarVipOnly);
            }
            elements.cardKpiVip.classList.toggle("active-filter", radarVipOnly);
            fetchRadarData();
        });
    }

    if (elements.radarSearchInput) {
        elements.radarSearchInput.addEventListener("input", () => {
            const val = elements.radarSearchInput.value;
            radarSearch = val;
            if (elements.radarSearchClear) {
                elements.radarSearchClear.style.display = val ? "block" : "none";
            }
            if (radarSearchDebounceTimer) clearTimeout(radarSearchDebounceTimer);
            radarSearchDebounceTimer = setTimeout(() => {
                fetchRadarData();
            }, 250);
        });
    }

    if (elements.radarSearchClear) {
        elements.radarSearchClear.addEventListener("click", () => {
            triggerHaptic("light");
            elements.radarSearchInput.value = "";
            radarSearch = "";
            elements.radarSearchClear.style.display = "none";
            fetchRadarData();
        });
    }

    // =====================================================================
    // RADAR SUB-TABS & ADVANCED CONTROLS
    // =====================================================================
    if (elements.subTabDonors) {
        elements.subTabDonors.addEventListener("click", () => switchRadarSubTab("donors"));
    }
    if (elements.subTabAlerts) {
        elements.subTabAlerts.addEventListener("click", () => switchRadarSubTab("alerts"));
    }
    if (elements.subTabLoyalty) {
        elements.subTabLoyalty.addEventListener("click", () => switchRadarSubTab("loyalty"));
    }

    // Whale Sound Toggle
    if (elements.btnToggleWhaleSound) {
        elements.btnToggleWhaleSound.addEventListener("click", () => {
            whaleSoundEnabled = !whaleSoundEnabled;
            triggerHaptic("medium");
            if (elements.whaleSoundIcon) {
                elements.whaleSoundIcon.textContent = whaleSoundEnabled ? "🔊" : "🔇";
            }
            if (elements.btnToggleWhaleSound) {
                elements.btnToggleWhaleSound.classList.toggle("active", whaleSoundEnabled);
            }
            if (whaleSoundEnabled) {
                initAudioContext();
                playWhaleAlertChime(true);
                showToast("Whale-Sound aktiviert (Web Audio Chime)", "success");
            } else {
                showToast("Whale-Sound stummgeschaltet", "info");
            }
        });
    }

    // Whale Alert Threshold Pills
    if (elements.alertThresholdPills) {
        elements.alertThresholdPills.forEach(pill => {
            pill.addEventListener("click", () => {
                const min = parseInt(pill.getAttribute("data-min") || "1000", 10);
                if (min === whaleAlertMinCoins) return;
                triggerHaptic("light");
                whaleAlertMinCoins = min;
                elements.alertThresholdPills.forEach(p => p.classList.remove("active"));
                pill.classList.add("active");
                fetchWhaleAlerts();
            });
        });
    }

    // Refresh Whale Alerts
    if (elements.btnRefreshWhaleAlerts) {
        elements.btnRefreshWhaleAlerts.addEventListener("click", () => {
            triggerHaptic("light");
            fetchWhaleAlerts();
        });
    }

    // Loyalty Days Pills
    if (elements.loyaltyDaysPills) {
        elements.loyaltyDaysPills.forEach(pill => {
            pill.addEventListener("click", () => {
                const days = parseInt(pill.getAttribute("data-days") || "14", 10);
                if (days === loyaltyDaysRecent) return;
                triggerHaptic("light");
                loyaltyDaysRecent = days;
                elements.loyaltyDaysPills.forEach(p => p.classList.remove("active"));
                pill.classList.add("active");
                fetchLoyaltyData();
            });
        });
    }

    // Refresh Loyalty
    if (elements.btnRefreshLoyalty) {
        elements.btnRefreshLoyalty.addEventListener("click", () => {
            triggerHaptic("light");
            fetchLoyaltyData();
        });
    }

    // Refresh Button Click
    if (elements.btnRefresh) {
        elements.btnRefresh.addEventListener("click", () => {
            triggerHaptic("light");
            lastAnalyticsFingerprint = null;
            fetchMiniAppData();
            if (activeTab === "tab-analytics") fetchAnalyticsData();
            if (activeTab === "tab-radar") {
                fetchRadarData();
                fetchWhaleTicker(true);
                if (radarSubTab === "alerts") fetchWhaleAlerts();
                if (radarSubTab === "loyalty") fetchLoyaltyData();
            }
            if (activeTab === "tab-admin" && isAdmin) loadAdminData();
        });
    }

    // Initial Start
    initAuth();
    fetchMiniAppData();
    pollInterval = setInterval(fetchMiniAppData, 8000);

    // Visibility change handling: smart conservation
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            if (pollInterval) clearInterval(pollInterval);
            stopRadarPolling();
        } else {
            fetchMiniAppData();
            pollInterval = setInterval(fetchMiniAppData, 8000);
            if (activeTab === "tab-radar") {
                fetchRadarData();
                fetchWhaleTicker(true);
                startRadarPolling();
            }
        }
    });

})();
