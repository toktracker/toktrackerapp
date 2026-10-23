let currentPeriod = "all";
let cachedStreamers = [];
let cachedGifts = [];
let cachedWorkers = [];
let cachedTgLogs = [];

let analyticsPeriod = "24h";
let analyticsStreamerId = "all";
let analyticsTimelineMode = "both"; // 'both', 'multi', 'eur', 'coins'
let cachedAnalyticsData = null;

let chartTimelineInstance = null;
let chartCompareInstance = null;
let chartTimeOfDayInstance = null;
let chartGiftDistInstance = null;
let chartTopGiftersInstance = null;

let analyticsLoadedOnce = false;
let lastAnalyticsFingerprint = null;
let analyticsAutoRefreshTimer = null;

function updateAnalyticsTimestamp() {
    const el = document.getElementById("anLastUpdated");
    if (el) {
        const d = new Date();
        const timeStr = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        el.textContent = `Stand: ${timeStr}`;
    }
}

function fmtEUR(v) {
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(v || 0);
}

function fmtUSD(v) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v || 0);
}

function fmtNum(v) {
    return new Intl.NumberFormat("de-DE").format(v || 0);
}

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getChartThemeColors() {
    const isDark = (document.documentElement.getAttribute("data-theme") || "dark") === "dark";
    return {
        isDark,
        textColor: isDark ? "#c9d1d9" : "#24292f",
        mutedColor: isDark ? "#8b949e" : "#57606a",
        gridColor: isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.08)",
        borderColor: isDark ? "#30363d" : "#d0d7de",
        tooltipBg: isDark ? "#161b22" : "#ffffff",
        tooltipText: isDark ? "#f0f6fc" : "#0d1117",
        tooltipBorder: isDark ? "#30363d" : "#d0d7de",
        primary: "#58a6ff",
        secondary: "#3fb950",
        accentGold: "#d29922",
        accentPurple: "#bc8cff",
        accentPink: "#f778ba",
        accentCyan: "#39c5cf",
        palette: [
            "#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba",
            "#39c5cf", "#ffa657", "#ff7b72", "#7ee787", "#79c0ff"
        ]
    };
}

function applyTheme(theme) {
    const normalized = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", normalized);
    try {
        localStorage.setItem("toktracker_theme", normalized);
    } catch (e) {}
    const btn = document.getElementById("btnThemeToggle");
    if (btn) {
        btn.textContent = normalized === "dark" ? "Theme: DARK" : "Theme: LIGHT";
    }
    if (cachedAnalyticsData) {
        if (chartTimelineInstance) { chartTimelineInstance.destroy(); chartTimelineInstance = null; }
        if (chartCompareInstance) { chartCompareInstance.destroy(); chartCompareInstance = null; }
        if (chartTimeOfDayInstance) { chartTimeOfDayInstance.destroy(); chartTimeOfDayInstance = null; }
        if (chartGiftDistInstance) { chartGiftDistInstance.destroy(); chartGiftDistInstance = null; }
        if (chartTopGiftersInstance) { chartTopGiftersInstance.destroy(); chartTopGiftersInstance = null; }
        renderTimelineChart(cachedAnalyticsData);
        renderCompareChart(cachedAnalyticsData);
        renderTimeOfDayChart(cachedAnalyticsData);
        renderGiftDistChart(cachedAnalyticsData);
        renderTopGiftersChart(cachedAnalyticsData);
    }
}

function switchTab(tabId) {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-tab") === tabId);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === tabId);
    });
    if (tabId === "tab-analytics") {
        if (!analyticsLoadedOnce) {
            analyticsLoadedOnce = true;
            setTimeout(() => {
                loadAnalytics();
            }, 50);
        }
    } else if (tabId === "tab-battles") {
        setTimeout(() => {
            loadBattles();
            loadBattleStats();
        }, 50);
    } else if (tabId === "tab-system") {
        setTimeout(() => {
            fetchSystemHealth();
        }, 50);
    }
}

async function loadOverview() {
    try {
        const res = await fetch(`/api/overview?period=${encodeURIComponent(currentPeriod)}`);
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        const data = await res.json();

        const t = data.totals || {};
        document.getElementById("sumNetEur").textContent = fmtEUR(t.eur_net);
        document.getElementById("sumNetUsd").textContent = `${fmtUSD(t.usd_net)} USD`;
        document.getElementById("sumCoins").textContent = fmtNum(t.total_coins);
        document.getElementById("sumStreamersSub").textContent =
            `${fmtNum(t.streamer_count)} Streamer (${fmtNum(t.live_count)} LIVE)`;
        document.getElementById("sumGrossEur").textContent = fmtEUR(t.eur_gross);
        document.getElementById("sumGrossUsd").textContent = `${fmtUSD(t.usd_gross)} USD`;
        document.getElementById("sumGiftsSent").textContent = fmtNum(t.total_gifts_sent);
        document.getElementById("sumGiftEvents").textContent = `${fmtNum(t.gift_events_count)} Transaktionen`;

        document.getElementById("badgeStreamers").textContent = fmtNum(t.streamer_count || 0);
        document.getElementById("badgeAnalytics").textContent = fmtNum(t.streamer_count || 0);
        document.getElementById("badgeGifts").textContent = fmtNum(t.gift_events_count || 0);
        document.getElementById("badgeTgUsers").textContent = fmtNum((data.telegram_users || []).length);

        if (data.system) {
            document.getElementById("sysWorkerInfo").textContent =
                `${data.system.workers_running} aktiv (${data.system.workers_connected} verbunden)`;

            const tg = data.system.telegram_bot;
            if (tg) {
                const tgLabel = tg.bot_username
                    ? `${tg.state.toUpperCase()} (${tg.bot_username})`
                    : tg.state.toUpperCase();
                document.getElementById("sysTelegramInfo").textContent = tgLabel;
                if (tg.access_mode) {
                    document.getElementById("sysTelegramMode").textContent = tg.access_mode.toUpperCase();
                }
            }
            cachedWorkers = data.system.workers || [];
            cachedTgLogs = tg ? tg.logs || [] : [];
            renderServiceLogs();

            if (data.system.system_health) {
                renderSystemHealth(data.system.system_health);
            }
        }

        if (data.settings) {
            const activeEl = document.activeElement;
            if (!activeEl || !activeEl.id.startsWith("set")) {
                document.getElementById("setUsdPerDiamond").value = data.settings.usd_per_diamond;
                document.getElementById("setGrossUsdPerCoin").value = data.settings.gross_usd_per_coin;
                document.getElementById("setUsdToEur").value = data.settings.usd_to_eur_rate;
                document.getElementById("setPollInterval").value = data.settings.poll_interval_seconds;
            }
            const modeSel = document.getElementById("selectTelegramMode");
            if (modeSel && activeEl !== modeSel && data.settings.telegram_access_mode) {
                modeSel.value = data.settings.telegram_access_mode;
            }
        }

        cachedStreamers = data.streamers || [];
        cachedGifts = data.recent_gifts || [];

        renderStreamerTable();
        renderGiftLog();
        renderTelegramUsers(
            data.telegram_users || [],
            data.settings ? data.settings.telegram_access_mode : "whitelist"
        );
        populateSimulatorSelect(cachedStreamers);
        populateAnalyticsStreamerSelect(cachedStreamers);
        populateBattleStreamerSelect(cachedStreamers);
    } catch (e) {
        console.error("Fehler beim Laden:", e);
    }
}

function renderStreamerTable() {
    const tbody = document.getElementById("streamerTableBody");
    const filterVal = (document.getElementById("inputStreamerFilter")?.value || "").trim().toLowerCase();

    const filtered = cachedStreamers.filter((s) => {
        if (!filterVal) return true;
        const u = (s.username || "").toLowerCase();
        const d = (s.display_name || "").toLowerCase();
        return u.includes(filterVal) || d.includes(filterVal);
    });

    document.getElementById("streamerTableMeta").textContent =
        `${filtered.length} von ${cachedStreamers.length} Streamern`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="muted">Keine passenden Streamer vorhanden.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered
        .map((s) => {
            const diag = s.worker_diagnostics;
            const state = diag ? diag.state : (s.is_live ? "live" : "stopped");
            let tagClass = "";
            if (state === "connected" || s.is_live) tagClass = "live";
            else if (state === "polling_offline" || state === "connecting" || state === "backoff") tagClass = "polling";

            const isAutoMarked = Boolean(s.auto_monitor || s.is_tracking);
            const autoBadge = isAutoMarked
                ? `<span class="status-tag live" title="In Datenbank für automatische Aufzeichnung beim Programmstart markiert">AUTO-START</span>`
                : `<span class="status-tag" title="Kein Auto-Start beim Programmstart">MANUELL</span>`;

            const topGift = s.top_gift
                ? `${s.top_gift.gift_name} (${fmtNum(s.top_gift.coins)})`
                : "-";
            const topGifter = s.top_gifter
                ? `@${s.top_gifter.sender_username} (${fmtNum(s.top_gifter.coins)})`
                : "-";

            const trackBtnText = s.is_tracking_active ? "Stop" : "Start";

            return `
                <tr>
                    <td class="mono muted hide-sm">#${s.id}</td>
                    <td>
                        <strong><a href="#" onclick="showStreamerDetail(${s.id}); return false;">${s.display_name || s.username}</a></strong>
                        <div class="mono muted">@${s.username}${s.room_id ? ` · Room ${s.room_id}` : ""}</div>
                    </td>
                    <td class="hide-sm">
                        <div style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
                            <span class="status-tag ${tagClass}">${state.toUpperCase()}</span>
                            ${autoBadge}
                        </div>
                        <div class="mono muted" style="margin-top:3px;">${s.monitor_status || ""}</div>
                        ${s.last_error ? `<div class="mono err-text">${s.last_error}</div>` : ""}
                    </td>
                    <td class="num-col hide-md">
                        <strong>${fmtNum(s.current_viewers || 0)}</strong>
                        <div class="muted">${fmtNum(s.follower_count || 0)} Follower</div>
                    </td>
                    <td class="num-col">
                        <strong>${fmtNum(s.total_coins)}</strong>
                        <div class="muted">${fmtNum(s.total_gifts_sent)} Gifts / ${s.unique_gifters} Gifter</div>
                    </td>
                    <td class="num-col"><strong>${fmtEUR(s.eur_net)}</strong></td>
                    <td class="num-col hide-sm">${fmtUSD(s.usd_net)}</td>
                    <td class="num-col hide-md">${fmtEUR(s.eur_gross)}</td>
                    <td class="mono hide-sm">
                        <div>Gift: ${topGift}</div>
                        <div class="muted">Spender: ${topGifter}</div>
                    </td>
                    <td>
                        <div class="action-group">
                            <button type="button" class="sm primary" onclick="openStreamerAnalytics(${s.id})">Analytics</button>
                            <button type="button" class="sm" onclick="toggleWorker(${s.id})">${trackBtnText}</button>
                            <button type="button" class="sm" onclick="showStreamerDetail(${s.id})">Details</button>
                            <button type="button" class="sm" onclick="refreshStreamer(${s.id})" title="TikTok Profil aktualisieren">Sync</button>
                            <a class="btn-link sm mono hide-sm" href="/api/v1/streamers/${encodeURIComponent(s.username)}/report?hours=24" target="_blank">JSON</a>
                            <button type="button" class="sm danger" onclick="deleteStreamer(${s.id}, '${s.username}')">X</button>
                        </div>
                    </td>
                </tr>
            `;
        })
        .join("");
}

function renderGiftLog() {
    const tbody = document.getElementById("giftLogBody");
    const filterVal = (document.getElementById("inputGiftFilter")?.value || "").trim().toLowerCase();

    const filtered = cachedGifts.filter((g) => {
        if (!filterVal) return true;
        return (
            (g.streamer_username || "").toLowerCase().includes(filterVal) ||
            (g.sender_username || "").toLowerCase().includes(filterVal) ||
            (g.sender_nickname || "").toLowerCase().includes(filterVal) ||
            (g.gift_name || "").toLowerCase().includes(filterVal)
        );
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="muted">Keine Geschenke im gewählten Zeitraum.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered
        .map((g) => {
            const ts = (g.created_at || "").replace("T", " ");
            return `
                <tr>
                    <td class="mono muted">${ts}</td>
                    <td class="mono"><strong>@${g.streamer_username}</strong></td>
                    <td>
                        ${g.sender_nickname || g.sender_username}
                        <span class="mono muted hide-sm">(@${g.sender_username})</span>
                        ${g.is_super_fan ? `<span class="status-tag polling">SUPERFAN</span>` : ""}
                    </td>
                    <td class="hide-sm"><strong>${g.repeat_count}x</strong> ${g.gift_name}</td>
                    <td class="num-col"><strong>${fmtNum(g.total_coins)}</strong></td>
                    <td class="num-col"><strong>${fmtEUR(g.eur_net)}</strong></td>
                    <td class="num-col hide-sm">${fmtUSD(g.usd_net)}</td>
                    <td class="mono muted hide-sm">${g.source}</td>
                </tr>
            `;
        })
        .join("");
}

function renderTelegramUsers(users, accessMode) {
    const tbody = document.getElementById("telegramUsersBody");
    if (!tbody) return;
    if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted">Noch keine Telegram-Nutzer hinterlegt. Trage oben eine Telegram-ID oder einen @username ein oder sende <code>/start</code> an den Bot.</td></tr>`;
        return;
    }

    tbody.innerHTML = users
        .map((u) => {
            const allowed = parseInt(u.is_allowed || 0, 10);
            let statusHtml = "";
            if (allowed === 1) {
                statusHtml = `<span class="status-tag live">FREIGESCHALTET</span>`;
            } else if (allowed === 0) {
                statusHtml =
                    accessMode === "public"
                        ? `<span class="status-tag polling">PUBLIC-GAST</span>`
                        : `<span class="status-tag polling">ANFRAGE OFFEN</span>`;
            } else {
                statusHtml = `<span class="status-tag danger">GESPERRT</span>`;
            }

            const roleBadge = u.role === "admin" ? `<strong>ADMIN</strong>` : `Nutzer`;
            const ident = u.telegram_id ? String(u.telegram_id) : `@${u.username}`;
            const unameStr = u.username ? `@${u.username}` : "-";
            const fnameStr = u.first_name ? ` (${u.first_name})` : "";
            const lastSeen = (u.last_seen_at || "").replace("T", " ");

            return `
                <tr>
                    <td class="mono hide-sm">${u.telegram_id || `<span class="muted">wird bei Nachricht verknüpft</span>`}</td>
                    <td><strong>${unameStr}</strong>${fnameStr}</td>
                    <td class="mono">${roleBadge}</td>
                    <td>${statusHtml}</td>
                    <td class="mono muted hide-sm">${u.note || "-"}</td>
                    <td class="mono muted hide-md">${lastSeen}</td>
                    <td>
                        <div class="action-group">
                            ${
                                allowed !== 1
                                    ? `<button type="button" class="sm primary" onclick="updateTgUser('${ident}', 1, '${u.role || "user"}')">Freischalten</button>`
                                    : `<button type="button" class="sm" onclick="updateTgUser('${ident}', -1, 'user')">Sperren</button>`
                            }
                            ${
                                u.role !== "admin"
                                    ? `<button type="button" class="sm" onclick="updateTgUser('${ident}', 1, 'admin')">→ Admin</button>`
                                    : `<button type="button" class="sm" onclick="updateTgUser('${ident}', 1, 'user')">→ Nutzer</button>`
                            }
                            <button type="button" class="sm danger" onclick="deleteTgUser(${u.id})">X</button>
                        </div>
                    </td>
                </tr>
            `;
        })
        .join("");
}

async function updateTgUser(identifier, isAllowed, role) {
    await fetch("/api/v1/telegram/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            identifier: String(identifier),
            is_allowed: isAllowed,
            role: role,
        }),
    });
    loadOverview();
}

async function deleteTgUser(recordId) {
    if (!confirm("Diesen Telegram-Eintrag wirklich entfernen?")) return;
    await fetch(`/api/v1/telegram/users/${recordId}`, { method: "DELETE" });
    loadOverview();
}

function renderServiceLogs() {
    const box = document.getElementById("workerLogBox");
    const sourceFilter = document.getElementById("selectLogSource")?.value || "all";
    const lines = [];

    if (sourceFilter === "all" || sourceFilter === "TikTok") {
        cachedWorkers.forEach((w) => {
            (w.logs || []).forEach((l) => {
                lines.push(`${l.timestamp} [TikTok:@${w.username}] [${l.level}] ${l.message}`);
            });
        });
    }
    if (sourceFilter === "all" || sourceFilter === "TelegramBot") {
        cachedTgLogs.forEach((l) => {
            lines.push(`${l.timestamp} [TelegramBot] [${l.level}] ${l.message}`);
        });
    }

    lines.sort().reverse();
    box.innerHTML = lines.length > 0 ? lines.slice(0, 45).join("<br/>") : "Keine Service-Logs für diese Auswahl vorhanden.";
}

function populateSimulatorSelect(streamers) {
    const sel = document.getElementById("simStreamerSelect");
    const prev = sel.value;
    sel.innerHTML =
        `<option value="">Streamer wählen</option>` +
        streamers.map((s) => `<option value="${s.id}">@${s.username}</option>`).join("");
    if (prev && streamers.some((s) => String(s.id) === String(prev))) {
        sel.value = prev;
    } else if (streamers.length > 0) {
        sel.value = streamers[0].id;
    }
}

async function showStreamerDetail(streamerId) {
    const res = await fetch(`/api/streamers/${streamerId}?period=${encodeURIComponent(currentPeriod)}`);
    if (!res.ok) return;
    const data = await res.json();
    const s = data.streamer;

    document.getElementById("detailTitle").textContent =
        `Auswertung: ${s.display_name || s.username} (@${s.username})`;
    document.getElementById("detailSubtitle").textContent =
        `Netto: ${fmtEUR(data.summary.eur_net)} (${fmtUSD(data.summary.usd_net)}) · Coins: ${fmtNum(data.summary.total_coins)} · Brutto: ${fmtEUR(data.summary.eur_gross)}`;

    const giftsBody = document.getElementById("detailGiftsBody");
    giftsBody.innerHTML =
        data.gift_breakdown.length === 0
            ? `<tr><td colspan="4" class="muted">Keine Geschenke aufgezeichnet.</td></tr>`
            : data.gift_breakdown
                  .map(
                      (g) => `
                <tr>
                    <td><strong>${g.gift_name}</strong> <span class="mono muted">(${g.diamond_count})</span></td>
                    <td class="num-col">${fmtNum(g.total_quantity)}x</td>
                    <td class="num-col">${fmtNum(g.total_coins)}</td>
                    <td class="num-col"><strong>${fmtEUR(g.eur_net)}</strong></td>
                </tr>`
                  )
                  .join("");

    const giftersBody = document.getElementById("detailGiftersBody");
    giftersBody.innerHTML =
        data.top_gifters.length === 0
            ? `<tr><td colspan="4" class="muted">Keine Spender aufgezeichnet.</td></tr>`
            : data.top_gifters
                  .map(
                      (tg) => `
                <tr>
                    <td><strong>@${tg.sender_username}</strong> ${tg.is_super_fan ? `<span class="status-tag polling">SF</span>` : ""}</td>
                    <td class="num-col">${fmtNum(tg.gifts_sent)}</td>
                    <td class="num-col">${fmtNum(tg.total_coins)}</td>
                    <td class="num-col"><strong>${fmtEUR(tg.eur_net)}</strong></td>
                </tr>`
                  )
                  .join("");

    const sessBox = document.getElementById("detailSessionsList");
    sessBox.innerHTML =
        (data.sessions || []).length === 0
            ? "Noch keine aufgezeichneten Live-Sessions."
            : data.sessions
                  .map(
                      (ss) =>
                          `#${ss.id} [${ss.status.toUpperCase()}] Start: ${ss.started_at} | Peak Viewers: ${fmtNum(ss.peak_viewers)} | Coins: ${fmtNum(ss.session_coins)} (${fmtEUR(ss.eur_net)})`
                  )
                  .join("<br/>");

    const box = document.getElementById("streamerDetailBox");
    box.style.display = "block";
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function toggleWorker(streamerId) {
    const autoReconnect = document.getElementById("checkAutoReconnect").checked;
    await fetch(`/api/streamers/${streamerId}/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", auto_reconnect: autoReconnect }),
    });
    loadOverview();
}

async function refreshStreamer(streamerId) {
    await fetch(`/api/streamers/${streamerId}/refresh`, { method: "POST" });
    loadOverview();
}

async function deleteStreamer(streamerId, username) {
    if (!confirm(`Streamer @${username} wirklich löschen?`)) return;
    await fetch(`/api/streamers/${streamerId}`, { method: "DELETE" });
    loadOverview();
}

function populateAnalyticsStreamerSelect(streamers) {
    const sel = document.getElementById("selectAnalyticsStreamer");
    if (!sel) return;
    const currentVal = sel.value || analyticsStreamerId || "all";

    sel.innerHTML = `<option value="all">Alle überwachten Streamer (Vergleich &amp; Gesamt)</option>` +
        streamers.map(s => {
            const liveMarker = s.is_live ? " [LIVE]" : "";
            const dName = s.display_name && s.display_name !== s.username ? `${s.display_name} (@${s.username})` : `@${s.username}`;
            return `<option value="${s.id}">${dName}${liveMarker}</option>`;
        }).join("");

    if (currentVal && (currentVal === "all" || streamers.some(s => String(s.id) === String(currentVal)))) {
        sel.value = currentVal;
    }
}

function openStreamerAnalytics(streamerId) {
    analyticsStreamerId = String(streamerId);
    const sel = document.getElementById("selectAnalyticsStreamer");
    if (sel) {
        sel.value = String(streamerId);
    }
    lastAnalyticsFingerprint = null;
    analyticsLoadedOnce = true;
    switchTab("tab-analytics");
    loadAnalytics();
}

function setChartEmptyState(canvasId, msg = "Keine Daten im gewählten Zeitraum vorhanden") {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    let emptyEl = parent.querySelector(".chart-empty-msg");
    if (!emptyEl) {
        emptyEl = document.createElement("div");
        emptyEl.className = "chart-empty-msg";
        parent.appendChild(emptyEl);
    }
    emptyEl.textContent = msg;
    emptyEl.style.display = "flex";
    canvas.style.display = "none";
}

function clearChartEmptyState(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (parent) {
        const emptyEl = parent.querySelector(".chart-empty-msg");
        if (emptyEl) emptyEl.style.display = "none";
    }
    canvas.style.display = "block";
}

function toggleTimelineMetric() {
    const modes = ["both", "multi", "eur", "coins"];
    let nextIdx = (modes.indexOf(analyticsTimelineMode) + 1) % modes.length;
    analyticsTimelineMode = modes[nextIdx];

    const btn = document.getElementById("btnTimelineToggleMetric");
    if (btn) {
        if (analyticsTimelineMode === "both") btn.textContent = "Metrik: Coins & EUR";
        else if (analyticsTimelineMode === "multi") btn.textContent = "Metrik: Top-Streamer Vergleich";
        else if (analyticsTimelineMode === "eur") btn.textContent = "Metrik: Nur Netto EUR";
        else if (analyticsTimelineMode === "coins") btn.textContent = "Metrik: Nur Coins";
    }

    if (cachedAnalyticsData) {
        renderTimelineChart(cachedAnalyticsData);
    }
}

function renderTimelineChart(data) {
    const canvas = document.getElementById("chartTimeline");
    if (!canvas || typeof Chart === "undefined") return;

    if (chartTimelineInstance) {
        chartTimelineInstance.destroy();
        chartTimelineInstance = null;
    }

    const timeline = data.timeline || [];
    if (timeline.length === 0) {
        setChartEmptyState("chartTimeline", "Keine Einnahmen-Events im gewählten Zeitraum vorhanden.");
        return;
    }
    clearChartEmptyState("chartTimeline");

    const colors = getChartThemeColors();
    const labels = timeline.map(t => t.label);

    const titleEl = document.getElementById("timelineChartTitle");
    const subEl = document.getElementById("timelineChartSubtitle");
    const isSingleStreamer = Boolean(data.selected_streamer);
    const streamerName = isSingleStreamer ? (data.selected_streamer.display_name || data.selected_streamer.username) : "Alle Streamer";

    let chartType = "bar";
    let datasets = [];
    let scales = {
        x: {
            grid: { color: colors.gridColor },
            ticks: { color: colors.mutedColor, font: { size: 11, family: "JetBrains Mono" } }
        },
        y: {
            position: "left",
            grid: { color: colors.gridColor },
            ticks: { color: colors.mutedColor, font: { size: 11, family: "JetBrains Mono" } },
            title: { display: true, text: "Coins", color: colors.mutedColor, font: { size: 11, family: "JetBrains Mono" } }
        }
    };

    if (analyticsTimelineMode === "multi" && !isSingleStreamer && data.multi_streamer_datasets && data.multi_streamer_datasets.length > 0) {
        chartType = "line";
        if (titleEl) titleEl.textContent = `Top-Streamer Einnahmen-Vergleich (${labels.length} Intervalle)`;
        if (subEl) subEl.textContent = `Chronologischer Coin-Verlauf der aktivsten Streamer`;
        datasets = data.multi_streamer_datasets.map((s, idx) => {
            const color = colors.palette[idx % colors.palette.length];
            return {
                type: "line",
                label: `@${s.username}`,
                data: s.data,
                borderColor: color,
                backgroundColor: color,
                borderWidth: 2,
                pointRadius: 3,
                tension: 0.25,
                fill: false,
            };
        });
    } else if (analyticsTimelineMode === "coins") {
        chartType = "bar";
        if (titleEl) titleEl.textContent = `Coin-Verlauf · ${streamerName}`;
        if (subEl) subEl.textContent = `Chronologische Entwicklung der erhaltenen Coins im Zeitfenster`;
        datasets = [{
            type: "bar",
            label: "Coins",
            data: timeline.map(t => t.coins),
            backgroundColor: colors.accentGold + "dd",
            borderColor: colors.accentGold,
            borderWidth: 1,
            borderRadius: 2,
        }];
    } else if (analyticsTimelineMode === "eur") {
        chartType = "line";
        if (titleEl) titleEl.textContent = `Netto Creator-Auszahlung (EUR) · ${streamerName}`;
        if (subEl) subEl.textContent = `Chronologische Entwicklung der Netto-Erlöse in Euro`;
        scales.y.title.text = "Netto EUR (€)";
        scales.y.ticks.callback = (v) => `${v} €`;
        datasets = [{
            type: "line",
            label: "Netto EUR",
            data: timeline.map(t => t.eur_net),
            borderColor: colors.secondary,
            backgroundColor: colors.secondary + "26",
            borderWidth: 2,
            pointRadius: 3,
            fill: true,
            tension: 0.3,
        }];
    } else {
        // Mode "both" (default)
        chartType = "bar";
        if (titleEl) titleEl.textContent = `Einnahmen- & Coin-Verlauf · ${streamerName}`;
        if (subEl) subEl.textContent = `Balken: Coins (links) | Linie: Netto Creator-Auszahlung in Euro (rechts)`;
        scales.y1 = {
            position: "right",
            grid: { drawOnChartArea: false },
            ticks: {
                color: colors.mutedColor,
                font: { size: 11, family: "JetBrains Mono" },
                callback: (v) => `${v} €`
            },
            title: { display: true, text: "Netto EUR", color: colors.mutedColor, font: { size: 11, family: "JetBrains Mono" } }
        };
        datasets = [
            {
                type: "bar",
                label: "Coins",
                data: timeline.map(t => t.coins),
                backgroundColor: colors.accentGold + "99",
                borderColor: colors.accentGold,
                borderWidth: 1,
                borderRadius: 2,
                yAxisID: "y",
            },
            {
                type: "line",
                label: "Netto EUR (€)",
                data: timeline.map(t => t.eur_net),
                borderColor: colors.primary,
                backgroundColor: colors.primary + "22",
                borderWidth: 2,
                pointRadius: 3,
                fill: false,
                tension: 0.3,
                yAxisID: "y1",
            }
        ];
    }

    if (chartTimelineInstance && chartTimelineInstance.config.type === chartType) {
        chartTimelineInstance.data.labels = labels;
        chartTimelineInstance.data.datasets = datasets;
        chartTimelineInstance.options.scales = scales;
        chartTimelineInstance.update("none");
        return;
    }

    if (chartTimelineInstance) {
        chartTimelineInstance.destroy();
        chartTimelineInstance = null;
    }

    chartTimelineInstance = new Chart(canvas, {
        type: chartType,
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: colors.textColor, font: { family: "JetBrains Mono", size: 11 } }
                },
                tooltip: {
                    backgroundColor: colors.tooltipBg,
                    titleColor: colors.tooltipText,
                    bodyColor: colors.tooltipText,
                    borderColor: colors.tooltipBorder,
                    borderWidth: 1,
                    padding: 9,
                }
            },
            scales
        }
    });
}

function renderCompareChart(data) {
    const canvas = document.getElementById("chartCompare");
    if (!canvas || typeof Chart === "undefined") return;

    const colors = getChartThemeColors();
    const titleEl = document.getElementById("compareChartTitle");
    const subEl = document.getElementById("compareChartSubtitle");

    if (!data.selected_streamer) {
        if (titleEl) titleEl.textContent = "Streamer-Umsatz-Ranking";
        if (subEl) subEl.textContent = "Vergleich der überwachten Streamer nach generierten Coins";

        const topStreamers = (data.streamers_ranking || []).slice(0, 10);
        if (topStreamers.length === 0) {
            if (chartCompareInstance) {
                chartCompareInstance.destroy();
                chartCompareInstance = null;
            }
            setChartEmptyState("chartCompare", "Keine Streamer-Daten vorhanden.");
            return;
        }
        clearChartEmptyState("chartCompare");

        const labels = topStreamers.map(s => `@${s.username}`);
        const coinsData = topStreamers.map(s => s.total_coins);
        const eurData = topStreamers.map(s => s.eur_net);

        if (chartCompareInstance && chartCompareInstance.options.indexAxis === "y") {
            chartCompareInstance.data.labels = labels;
            chartCompareInstance.data.datasets[0].data = coinsData;
            chartCompareInstance.update("none");
            return;
        }

        if (chartCompareInstance) {
            chartCompareInstance.destroy();
            chartCompareInstance = null;
        }

        chartCompareInstance = new Chart(canvas, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: "Coins",
                    data: coinsData,
                    backgroundColor: colors.primary + "bb",
                    borderColor: colors.primary,
                    borderWidth: 1,
                    borderRadius: 2,
                }]
            },
            options: {
                indexAxis: "y",
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                const idx = ctx.dataIndex;
                                return ` Coins: ${fmtNum(coinsData[idx])} (${fmtEUR(eurData[idx])})`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: colors.gridColor },
                        ticks: { color: colors.mutedColor, font: { size: 10, family: "JetBrains Mono" } }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: colors.textColor, font: { size: 11, family: "JetBrains Mono" } }
                    }
                }
            }
        });
    } else {
        if (titleEl) titleEl.textContent = "Session-Performance & Peak-Viewers";
        if (subEl) subEl.textContent = "Peak-Zuschauer und generierte Coins der aufgezeichneten Streams";

        const sess = (data.sessions || []).slice(0, 10).reverse();
        if (sess.length === 0) {
            if (chartCompareInstance) {
                chartCompareInstance.destroy();
                chartCompareInstance = null;
            }
            setChartEmptyState("chartCompare", "Keine aufgezeichneten Sessions für diesen Streamer.");
            return;
        }
        clearChartEmptyState("chartCompare");

        const labels = sess.map(s => `#${s.id} (${(s.started_at || "").slice(5, 10)})`);
        const coinsData = sess.map(s => s.session_coins);
        const viewersData = sess.map(s => s.peak_viewers);

        if (chartCompareInstance && chartCompareInstance.options.indexAxis !== "y" && chartCompareInstance.data.datasets.length === 2) {
            chartCompareInstance.data.labels = labels;
            chartCompareInstance.data.datasets[0].data = coinsData;
            chartCompareInstance.data.datasets[1].data = viewersData;
            chartCompareInstance.update("none");
            return;
        }

        if (chartCompareInstance) {
            chartCompareInstance.destroy();
            chartCompareInstance = null;
        }

        chartCompareInstance = new Chart(canvas, {
            type: "bar",
            data: {
                labels,
                datasets: [
                    {
                        type: "bar",
                        label: "Coins",
                        data: coinsData,
                        backgroundColor: colors.accentGold + "bb",
                        borderColor: colors.accentGold,
                        borderWidth: 1,
                        borderRadius: 2,
                        yAxisID: "y",
                    },
                    {
                        type: "line",
                        label: "Peak Viewers",
                        data: viewersData,
                        borderColor: colors.accentPurple,
                        backgroundColor: colors.accentPurple,
                        borderWidth: 2,
                        pointRadius: 4,
                        tension: 0.25,
                        yAxisID: "y1",
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: colors.textColor, font: { family: "JetBrains Mono", size: 11 } }
                    }
                },
                scales: {
                    x: {
                        grid: { color: colors.gridColor },
                        ticks: { color: colors.mutedColor, font: { size: 10, family: "JetBrains Mono" } }
                    },
                    y: {
                        position: "left",
                        grid: { color: colors.gridColor },
                        ticks: { color: colors.mutedColor, font: { size: 10, family: "JetBrains Mono" } },
                        title: { display: true, text: "Coins", color: colors.mutedColor, font: { size: 10, family: "JetBrains Mono" } }
                    },
                    y1: {
                        position: "right",
                        grid: { drawOnChartArea: false },
                        ticks: { color: colors.mutedColor, font: { size: 10, family: "JetBrains Mono" } },
                        title: { display: true, text: "Peak Viewers", color: colors.mutedColor, font: { size: 10, family: "JetBrains Mono" } }
                    }
                }
            }
        });
    }
}

function renderTimeOfDayChart(data) {
    const canvas = document.getElementById("chartTimeOfDay");
    if (!canvas || typeof Chart === "undefined") return;

    const tod = data.time_of_day || [];
    clearChartEmptyState("chartTimeOfDay");

    const colors = getChartThemeColors();
    const labels = tod.map(t => t.label);
    const coinsData = tod.map(t => t.coins);
    const eventsData = tod.map(t => t.events_count);

    const maxCoins = Math.max(...coinsData, 0);
    const bgColors = coinsData.map(c => {
        if (c === maxCoins && c > 0) return colors.accentGold;
        return colors.accentPurple + "bb";
    });

    if (chartTimeOfDayInstance) {
        chartTimeOfDayInstance.data.labels = labels;
        chartTimeOfDayInstance.data.datasets[0].data = coinsData;
        chartTimeOfDayInstance.data.datasets[0].backgroundColor = bgColors;
        chartTimeOfDayInstance.update("none");
        return;
    }

    chartTimeOfDayInstance = new Chart(canvas, {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Coins",
                data: coinsData,
                backgroundColor: bgColors,
                borderWidth: 0,
                borderRadius: 2,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(ctx) {
                            const idx = ctx.dataIndex;
                            return ` Coins: ${fmtNum(coinsData[idx])} (${fmtEUR(tod[idx].eur_net)} | ${eventsData[idx]} Events)`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: colors.gridColor },
                    ticks: {
                        color: colors.mutedColor,
                        font: { size: 10, family: "JetBrains Mono" },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 12
                    }
                },
                y: {
                    grid: { color: colors.gridColor },
                    ticks: { color: colors.mutedColor, font: { size: 10, family: "JetBrains Mono" } }
                }
            }
        }
    });
}

function renderGiftDistChart(data) {
    const canvas = document.getElementById("chartGiftDist");
    if (!canvas || typeof Chart === "undefined") return;

    const gifts = data.top_gifts || [];
    if (gifts.length === 0) {
        if (chartGiftDistInstance) {
            chartGiftDistInstance.destroy();
            chartGiftDistInstance = null;
        }
        setChartEmptyState("chartGiftDist", "Keine Geschenke im gewählten Zeitraum aufgezeichnet.");
        return;
    }
    clearChartEmptyState("chartGiftDist");

    const colors = getChartThemeColors();
    const top6 = gifts.slice(0, 6);
    const otherCoins = gifts.slice(6).reduce((acc, g) => acc + g.total_coins, 0);

    const labels = top6.map(g => `${g.gift_name} (${fmtNum(g.diamond_count)})`);
    const values = top6.map(g => g.total_coins);
    const bgColors = top6.map((_, i) => colors.palette[i % colors.palette.length]);

    if (otherCoins > 0) {
        labels.push("Andere Geschenke");
        values.push(otherCoins);
        bgColors.push(colors.mutedColor);
    }

    if (chartGiftDistInstance) {
        chartGiftDistInstance.data.labels = labels;
        chartGiftDistInstance.data.datasets[0].data = values;
        chartGiftDistInstance.data.datasets[0].backgroundColor = bgColors;
        chartGiftDistInstance.update("none");
        return;
    }

    chartGiftDistInstance = new Chart(canvas, {
        type: "doughnut",
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: bgColors,
                borderColor: colors.isDark ? "#12171f" : "#ffffff",
                borderWidth: 2,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "60%",
            plugins: {
                legend: {
                    position: "right",
                    labels: {
                        color: colors.textColor,
                        boxWidth: 12,
                        font: { family: "JetBrains Mono", size: 11 }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(ctx) {
                            const val = ctx.raw || 0;
                            const total = values.reduce((a, b) => a + b, 0);
                            const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
                            return ` ${ctx.label}: ${fmtNum(val)} Coins (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
}

function renderTopGiftersChart(data) {
    const canvas = document.getElementById("chartTopGifters");
    if (!canvas || typeof Chart === "undefined") return;

    const gifters = (data.top_gifters || []).slice(0, 10);
    if (gifters.length === 0) {
        if (chartTopGiftersInstance) {
            chartTopGiftersInstance.destroy();
            chartTopGiftersInstance = null;
        }
        setChartEmptyState("chartTopGifters", "Keine Spenderdaten im gewählten Zeitraum vorhanden.");
        return;
    }
    clearChartEmptyState("chartTopGifters");

    const colors = getChartThemeColors();
    const labels = gifters.map(g => `@${g.sender_username}`);
    const coinsData = gifters.map(g => g.total_coins);
    const eurData = gifters.map(g => g.eur_net);

    if (chartTopGiftersInstance) {
        chartTopGiftersInstance.data.labels = labels;
        chartTopGiftersInstance.data.datasets[0].data = coinsData;
        chartTopGiftersInstance.update("none");
        return;
    }

    chartTopGiftersInstance = new Chart(canvas, {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Coins",
                data: coinsData,
                backgroundColor: colors.secondary + "bb",
                borderColor: colors.secondary,
                borderWidth: 1,
                borderRadius: 2,
            }]
        },
        options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(ctx) {
                            const idx = ctx.dataIndex;
                            return ` Coins: ${fmtNum(coinsData[idx])} (${fmtEUR(eurData[idx])} | ${gifters[idx].gifts_sent} Gifts)`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: colors.gridColor },
                    ticks: { color: colors.mutedColor, font: { size: 10, family: "JetBrains Mono" } }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: colors.textColor, font: { size: 11, family: "JetBrains Mono" } }
                }
            }
        }
    });
}

function renderAnalyticsTables(data) {
    // 1. Top Gifters Table
    const giftersBody = document.getElementById("anGiftersTableBody");
    const giftersMeta = document.getElementById("anGiftersTableMeta");
    const gifters = data.top_gifters || [];
    if (giftersMeta) giftersMeta.textContent = `${gifters.length} Top-Spender`;

    if (giftersBody) {
        if (gifters.length === 0) {
            giftersBody.innerHTML = `<tr><td colspan="6" class="muted">Keine Spenderdaten im gewählten Zeitraum vorhanden.</td></tr>`;
        } else {
            giftersBody.innerHTML = gifters.map(g => {
                const topRankCls = g.rank <= 3 ? "rank-badge top-rank" : "rank-badge";
                const sfBadge = g.is_super_fan ? `<span class="status-tag polling">SF</span>` : "";
                return `
                    <tr>
                        <td><span class="${topRankCls}">${g.rank}</span></td>
                        <td>
                            <strong>@${g.sender_username}</strong> ${sfBadge}
                            ${g.sender_nickname && g.sender_nickname !== g.sender_username ? `<div class="mono muted" style="font-size:11px;">${g.sender_nickname}</div>` : ""}
                        </td>
                        <td class="num-col hide-sm">${fmtNum(g.gifts_sent)} (${fmtNum(g.transactions)})</td>
                        <td class="num-col"><strong>${fmtNum(g.total_coins)}</strong></td>
                        <td class="num-col"><strong>${fmtEUR(g.eur_net)}</strong></td>
                        <td class="num-col hide-sm">
                            <div class="pct-bar-wrapper">
                                <span class="pct-pill">${g.pct_of_total}%</span>
                                <span class="pct-bar-fill" style="width:${Math.max(2, Math.min(60, g.pct_of_total * 0.6))}px;"></span>
                            </div>
                        </td>
                    </tr>
                `;
            }).join("");
        }
    }

    // 2. Top Gifts Table
    const giftsBody = document.getElementById("anGiftsTableBody");
    const giftsMeta = document.getElementById("anGiftsTableMeta");
    const gifts = data.top_gifts || [];
    if (giftsMeta) giftsMeta.textContent = `${gifts.length} Geschenke`;

    if (giftsBody) {
        if (gifts.length === 0) {
            giftsBody.innerHTML = `<tr><td colspan="6" class="muted">Keine Geschenk-Daten im gewählten Zeitraum vorhanden.</td></tr>`;
        } else {
            giftsBody.innerHTML = gifts.map(g => {
                return `
                    <tr>
                        <td>
                            <strong>${g.gift_name}</strong>
                            ${g.gift_id ? `<span class="mono muted" style="font-size:10.5px;">(#${g.gift_id})</span>` : ""}
                        </td>
                        <td class="num-col hide-sm">${fmtNum(g.diamond_count)}</td>
                        <td class="num-col hide-sm">${fmtNum(g.total_quantity)}x</td>
                        <td class="num-col"><strong>${fmtNum(g.total_coins)}</strong></td>
                        <td class="num-col"><strong>${fmtEUR(g.eur_net)}</strong></td>
                        <td class="num-col hide-sm">
                            <div class="pct-bar-wrapper">
                                <span class="pct-pill">${g.pct_of_total}%</span>
                                <span class="pct-bar-fill" style="width:${Math.max(2, Math.min(60, g.pct_of_total * 0.6))}px;"></span>
                            </div>
                        </td>
                    </tr>
                `;
            }).join("");
        }
    }

    // 3. Sessions Table
    const sessBody = document.getElementById("anSessionsTableBody");
    const sessMeta = document.getElementById("anSessionsTableMeta");
    const sessions = data.sessions || [];
    if (sessMeta) sessMeta.textContent = `${sessions.length} Sessions`;

    if (sessBody) {
        if (sessions.length === 0) {
            sessBody.innerHTML = `<tr><td colspan="9" class="muted">Keine aufgezeichneten Live-Sessions vorhanden.</td></tr>`;
        } else {
            sessBody.innerHTML = sessions.map(ss => {
                const isLive = ss.status === "active";
                const statusTag = isLive ? `<span class="status-tag live">LIVE</span>` : `<span class="status-tag">BEENDET</span>`;
                const durStr = ss.duration_minutes >= 60
                    ? `${Math.floor(ss.duration_minutes / 60)}h ${ss.duration_minutes % 60}m`
                    : `${ss.duration_minutes}m`;

                return `
                    <tr>
                        <td class="mono muted hide-sm">#${ss.id}</td>
                        <td>
                            <strong>${ss.streamer_display_name}</strong>
                            <div class="mono muted" style="font-size:11px;">@${ss.streamer_username}</div>
                        </td>
                        <td class="mono">${(ss.started_at || "").replace("T", " ")}</td>
                        <td class="num-col">${durStr}</td>
                        <td class="num-col hide-sm"><strong>${fmtNum(ss.peak_viewers)}</strong></td>
                        <td class="hide-sm">${statusTag}</td>
                        <td class="num-col"><strong>${fmtNum(ss.session_coins)}</strong></td>
                        <td class="num-col"><strong>${fmtEUR(ss.eur_net)}</strong></td>
                        <td class="num-col mono hide-md"><strong>${fmtNum(ss.coins_per_hour)}</strong> <span class="muted">/h</span></td>
                    </tr>
                `;
            }).join("");
        }
    }
}

async function loadAnalytics(isBackground = false) {
    try {
        const sidParam = analyticsStreamerId && analyticsStreamerId !== "all" ? `&streamer_id=${encodeURIComponent(analyticsStreamerId)}` : "";
        const res = await fetch(`/api/analytics?period=${encodeURIComponent(analyticsPeriod)}${sidParam}`);
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        if (!res.ok) return;
        const data = await res.json();
        cachedAnalyticsData = data;

        const t = data.totals || {};
        const fingerprint = `${t.total_coins}_${t.gift_events_count}_${t.sessions_count}_${(data.timeline || []).length}_${(data.top_gifters || []).length}_${analyticsPeriod}_${analyticsStreamerId}_${analyticsTimelineMode}`;
        if (isBackground && lastAnalyticsFingerprint === fingerprint) {
            updateAnalyticsTimestamp();
            return;
        }
        lastAnalyticsFingerprint = fingerprint;

        // KPI updates
        const setText = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        setText("anNetEur", fmtEUR(t.eur_net));
        setText("anNetUsd", `${fmtUSD(t.usd_net)} USD`);
        setText("anGrossEur", fmtEUR(t.eur_gross));
        setText("anCoins", fmtNum(t.total_coins));
        setText("anAvgCoinsPerGift", `Ø ${fmtNum(t.avg_coins_per_gift)} Coins pro Gift`);
        setText("anGiftsCount", `${fmtNum(t.total_gifts_sent)} Gifts`);
        setText("anGiftEventsCount", `${fmtNum(t.gift_events_count)} Transaktionen`);
        setText("anUniqueGifters", `${fmtNum(t.unique_gifters)} Spender`);
        setText("anAvgPerGifter", `Ø ${fmtEUR(t.avg_eur_per_gifter)} pro Spender`);

        setText("anWhaleTop1", `${t.whale_share_top1_pct || 0.0}%`);
        setText("anWhaleTop3", `${t.whale_share_top3_pct || 0.0}%`);
        setText("anWhaleTop5", `${t.whale_share_top5_pct || 0.0}%`);

        const totalMins = t.total_stream_minutes || 0;
        const hoursStr = (totalMins / 60).toFixed(1);
        setText("anSessionsCount", `${fmtNum(t.sessions_count || 0)} Sessions`);
        setText("anStreamDuration", `${hoursStr} Std. Gesamtlaufzeit`);

        // Streamer Meta Banner
        const banner = document.getElementById("anStreamerMetaBanner");
        const bannerMeta = document.getElementById("anStreamerMeta");
        if (data.selected_streamer) {
            const s = data.selected_streamer;
            const liveBadge = s.is_live ? `<span class="status-tag live">LIVE</span>` : `<span class="status-tag">OFFLINE</span>`;
            banner.style.display = "block";
            bannerMeta.innerHTML = `Auswertung fokussiert auf: <strong>${s.display_name || s.username}</strong> (@${s.username}) · ${liveBadge} · ${fmtNum(s.follower_count)} Follower · Raum-ID: ${s.room_id || "Keine"}`;
        } else {
            banner.style.display = "none";
        }

        try { renderTimelineChart(data); } catch (e) { console.error("Fehler renderTimelineChart:", e); }
        try { renderCompareChart(data); } catch (e) { console.error("Fehler renderCompareChart:", e); }
        try { renderTimeOfDayChart(data); } catch (e) { console.error("Fehler renderTimeOfDayChart:", e); }
        try { renderGiftDistChart(data); } catch (e) { console.error("Fehler renderGiftDistChart:", e); }
        try { renderTopGiftersChart(data); } catch (e) { console.error("Fehler renderTopGiftersChart:", e); }
        try { renderAnalyticsTables(data); } catch (e) { console.error("Fehler renderAnalyticsTables:", e); }

        updateAnalyticsTimestamp();
    } catch (e) {
        console.error("Fehler beim Laden der Analytics:", e);
    }
}


/* ==========================================================================
   TIKTOK BATTLES & DUELLE LOGIK
   ========================================================================== */
let battleStreamerId = "";
let battleResultFilter = "ALL";
let battleModeFilter = "ALL";
let battlePeriod = "all";
let battleSearchTerm = "";
let battleCurrentPage = 0;
const BATTLE_PAGE_SIZE = 20;
let currentSelectedBattle = null;

function populateBattleStreamerSelect(streamers) {
    const sel = document.getElementById("battleStreamerSelect");
    if (!sel) return;
    const currentVal = sel.value || battleStreamerId || "";

    sel.innerHTML = `<option value="">Alle Streamer</option>` +
        streamers.map((s) => `<option value="${s.id}">@${escapeHtml(s.username)} (${escapeHtml(s.display_name || s.username)})</option>`).join("");

    if (currentVal && Array.from(sel.options).some(o => o.value === currentVal)) {
        sel.value = currentVal;
    } else {
        sel.value = "";
    }
}

async function loadBattles(isSilent = false) {
    try {
        const params = new URLSearchParams();
        if (battleStreamerId) params.append("streamer_id", battleStreamerId);
        if (battlePeriod) params.append("period", battlePeriod);
        if (battleResultFilter && battleResultFilter !== "ALL") params.append("result", battleResultFilter);
        if (battleModeFilter && battleModeFilter !== "ALL") params.append("mode", battleModeFilter);
        if (battleSearchTerm) params.append("search", battleSearchTerm);
        params.append("limit", String(BATTLE_PAGE_SIZE));
        params.append("offset", String(battleCurrentPage * BATTLE_PAGE_SIZE));

        const res = await fetch(`/api/battles?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json();

        // Update Tab-Badge
        const badge = document.getElementById("badgeBattles");
        if (badge) {
            const liveCount = (data.live_active_battles || []).length;
            if (liveCount > 0) {
                badge.textContent = `${liveCount} LIVE`;
                badge.style.background = "#ef4444";
                badge.style.color = "#ffffff";
            } else {
                badge.textContent = fmtNum(data.total || 0);
                badge.style.background = "";
                badge.style.color = "";
            }
        }

        renderLiveActiveBattles(data.live_active_battles || []);
        renderBattlesFeed(data);
    } catch (e) {
        if (!isSilent) console.error("Fehler loadBattles:", e);
    }
}

function renderLiveActiveBattles(liveBattles) {
    const container = document.getElementById("liveActiveBattlesContainer");
    const list = document.getElementById("liveActiveBattlesList");
    if (!container || !list) return;

    const validLive = liveBattles.filter(item => item && item.battle);
    if (validLive.length === 0) {
        container.style.display = "none";
        list.innerHTML = "";
        return;
    }

    container.style.display = "block";
    list.innerHTML = validLive.map(item => {
        const b = item.battle || {};
        const isInternal = Boolean(b.is_internal);

        if (isInternal) {
            const sA = b.streamer_a || {};
            const sB = b.streamer_b || {};
            const scoreA = (sA.score || 0).toLocaleString("de-DE");
            const scoreB = (sB.score || 0).toLocaleString("de-DE");
            const totCoins = (b.total_coins || 0).toLocaleString("de-DE");
            const totEur = fmtEUR(b.total_eur_net || 0);

            return `
                <div class="live-active-card card-derby" style="background:var(--bg-card); border:1px solid #8b5cf6; border-left:4px solid #8b5cf6; border-radius:6px; padding:12px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <div style="display:flex; align-items:center; gap:12px;">
                        <span class="live-pulse" style="background:#8b5cf6;"></span>
                        <div>
                            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                                <span class="mode-badge mode-derby" style="font-size:10px; padding:1px 6px;">⚔️ INTERNES DERBY</span>
                                <strong>@${escapeHtml(sA.username || '')}</strong> <span class="pct-pill" style="font-size:10px; color:#10b981; border-color:#10b981;">+${fmtEUR(sA.eur_net || 0)}</span>
                                <span style="color:#8b5cf6; font-weight:800;">VS</span>
                                <strong>@${escapeHtml(sB.username || '')}</strong> <span class="pct-pill" style="font-size:10px; color:#10b981; border-color:#10b981;">+${fmtEUR(sB.eur_net || 0)}</span>
                            </div>
                            <div class="muted" style="font-size:11px; margin-top:2px;">Battle #${escapeHtml(String(b.battle_id || ""))} · Live im Gange</div>
                        </div>
                    </div>
                    <div style="font-family:'JetBrains Mono', Consolas, monospace; font-size:18px; font-weight:800;">
                        <span style="color:#38bdf8;">${scoreA}</span> : <span style="color:#ec4899;">${scoreB}</span>
                    </div>
                    <div style="text-align:right;">
                        <span class="pct-pill" style="border-color:#f59e0b; color:#f59e0b; font-weight:700;">🔥 +${totCoins} Coins (${totEur})</span>
                    </div>
                </div>
            `;
        }

        const sName = escapeHtml(item.username || "Streamer");
        const oName = escapeHtml(b.opponent_display_name || b.opponent_username || "Gegner");
        const sScore = (b.streamer_score || 0).toLocaleString("de-DE");
        const oScore = (b.opponent_score || 0).toLocaleString("de-DE");
        const coins = (b.coins_earned || 0).toLocaleString("de-DE");

        const bMode = b.battle_mode || "1v1";
        const is2v2 = bMode === "2v2" || Boolean(b.teammate_username);
        const isFfa = bMode === "1v1v1" || bMode === "1v1v1v1";

        let modeBadge = `<span class="mode-badge mode-1v1" style="font-size:10px; padding:1px 5px;">1v1</span>`;
        if (bMode === "2v2") {
            modeBadge = `<span class="mode-badge mode-2v2" style="font-size:10px; padding:1px 5px;">2v2</span>`;
        } else if (bMode === "1v1v1") {
            modeBadge = `<span class="mode-badge mode-1v1v1" style="font-size:10px; padding:1px 5px;">1v1v1</span>`;
        } else if (bMode === "1v1v1v1") {
            modeBadge = `<span class="mode-badge mode-1v1v1v1" style="font-size:10px; padding:1px 5px;">4er-Einzel</span>`;
        }

        const tmStr = b.teammate_username ? ` <span class="muted" style="font-size:12px;">+ @${escapeHtml(b.teammate_username)}</span>` : "";
        const op2Str = b.opponent2_username ? ` <span class="muted" style="font-size:12px;">vs @${escapeHtml(b.opponent2_username)}</span>` : "";
        const op3Str = b.opponent3_username ? ` <span class="muted" style="font-size:12px;">vs @${escapeHtml(b.opponent3_username)}</span>` : "";

        return `
            <div class="live-active-card" style="background:var(--bg-card); border:1px solid #ef4444; border-radius:6px; padding:12px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; gap:12px;">
                    <span class="live-pulse"></span>
                    <div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            ${modeBadge}
                            <strong>@${sName}</strong>${tmStr} <span style="color:#ef4444; font-weight:700;">VS</span> <strong>@${escapeHtml(b.opponent_username || "Gegner")}</strong>${op2Str}${op3Str}
                        </div>
                        <div class="muted" style="font-size:11px; margin-top:2px;">Battle ID: #${escapeHtml(String(b.battle_id || ""))} · Live im Gange</div>
                    </div>
                </div>
                <div style="font-family:'JetBrains Mono', Consolas, monospace; font-size:16px; font-weight:800;">
                    <span style="color:#10b981;">${sScore}</span> : <span style="color:#ef4444;">${oScore}</span>
                </div>
                <div>
                    <span class="pct-pill" style="border-color:#f59e0b; color:#f59e0b;">+${coins} Coins</span>
                </div>
            </div>
        `;
    }).join("");
}

function renderBattlesFeed(data) {
    const feed = document.getElementById("battlesFeed");
    const empty = document.getElementById("battlesEmptyState");
    const meta = document.getElementById("battlesTableMeta");
    const pagination = document.getElementById("battlesPagination");
    const pageInfo = document.getElementById("battlesPageInfo");
    const prevBtn = document.getElementById("btnBattlesPrev");
    const nextBtn = document.getElementById("btnBattlesNext");

    if (!feed) return;

    const total = data.total || 0;
    if (meta) meta.textContent = `${fmtNum(total)} Duelle erfasst`;

    const battles = data.battles || [];
    if (battles.length === 0) {
        if (empty) empty.style.display = "block";
        feed.innerHTML = "";
        if (empty) feed.appendChild(empty);
        if (pagination) pagination.style.display = "none";
        return;
    }

    if (empty) empty.style.display = "none";

    feed.innerHTML = battles.map(b => {
        const isWin = b.result === "WIN";
        const isLose = b.result === "LOSE";
        const isDraw = b.result === "DRAW";
        const isOngoing = b.result === "ONGOING" || b.status === "active";

        const bMode = b.battle_mode || "1v1";
        const isFfa = bMode === "1v1v1" || bMode === "1v1v1v1";
        const is2v2 = bMode === "2v2" || Boolean(b.teammate_username);

        const isInternal = Boolean(b.is_internal);
        let cardClass = "card-draw";
        let resultLabel = "🤝 UNENTSCHIEDEN";
        let resultClass = "draw";

        if (isInternal) {
            cardClass = "card-derby";
            if (b.is_single_view) {
                if (isWin) {
                    resultLabel = "🏆 SIEG (INTERNES DUELL)";
                    resultClass = "win";
                } else if (isLose) {
                    resultLabel = "❌ NIEDERLAGE (INTERNES DUELL)";
                    resultClass = "lose";
                } else {
                    resultLabel = "🤝 UNENTSCHIEDEN";
                    resultClass = "draw";
                }
            } else {
                if (b.winner_username) {
                    resultLabel = `🏆 SIEGER: @${escapeHtml(b.winner_username)}`;
                    resultClass = "win";
                } else {
                    resultLabel = "🤝 UNENTSCHIEDEN";
                    resultClass = "draw";
                }
            }
        } else if (isFfa && !isOngoing) {
            const rank = b.streamer_rank || (isWin ? 1 : 2);
            if (rank === 1) {
                cardClass = "card-win";
                resultLabel = "🥇 1. PLATZ (SIEG)";
                resultClass = "win";
            } else if (rank === 2) {
                cardClass = "card-lose";
                resultLabel = "🥈 2. PLATZ";
                resultClass = "lose";
            } else if (rank === 3) {
                cardClass = "card-lose";
                resultLabel = "🥉 3. PLATZ";
                resultClass = "lose";
            } else {
                cardClass = "card-lose";
                resultLabel = "4. PLATZ";
                resultClass = "lose";
            }
        } else if (isWin) {
            cardClass = "card-win";
            resultLabel = "🏆 SIEG";
            resultClass = "win";
        } else if (isLose) {
            cardClass = "card-lose";
            resultLabel = "❌ NIEDERLAGE";
            resultClass = "lose";
        } else if (isOngoing) {
            cardClass = "card-ongoing";
            resultLabel = "🔴 LIVE DUELL";
            resultClass = "ongoing";
        }

        const sScore = (b.streamer_score || 0);
        const oScore = (b.opponent_score || 0);
        const totScore = sScore + oScore;
        const sPct = totScore > 0 ? Math.round((sScore / totScore) * 100) : 50;
        const oPct = 100 - sPct;

        const delta = Math.abs(sScore - oScore).toLocaleString("de-DE");
        const deltaText = isWin ? `+${delta} Pkt` : (isLose ? `-${delta} Pkt` : `Gleichstand`);

        const sAvatar = b.streamer_avatar_url || "/static/avatar_default.png";
        const oAvatar = b.opponent_avatar_url || "/static/avatar_default.png";

        const durMins = Math.floor((b.duration_seconds || 300) / 60);
        const durSecs = (b.duration_seconds || 300) % 60;
        const durStr = `${durMins}:${String(durSecs).padStart(2, "0")} Min`;

        const matchDate = b.started_at ? b.started_at.replace("T", " ").substring(0, 16) : "-";

        let modeBadge = `<span class="mode-badge mode-1v1">⚔️ 1 VS 1</span>`;
        if (isInternal) {
            modeBadge = `<span class="mode-badge mode-derby">⚔️ INTERNES DERBY</span>`;
        } else if (bMode === "2v2") {
            modeBadge = `<span class="mode-badge mode-2v2">👥 2 VS 2 TEAM</span>`;
        } else if (bMode === "1v1v1") {
            modeBadge = `<span class="mode-badge mode-1v1v1">🔺 1 VS 1 VS 1 (3ER)</span>`;
        } else if (bMode === "1v1v1v1") {
            modeBadge = `<span class="mode-badge mode-1v1v1v1">⚡ 4ER-EINZEL (1V1V1V1)</span>`;
        }

        let matchupRowHtml = "";
        if (isFfa) {
            // Free-for-all Leaderboard Layout (3er oder 4er-Einzel)
            const players = [
                {
                    username: b.streamer_username,
                    name: b.streamer_display_name || b.streamer_username,
                    avatar: sAvatar,
                    score: sScore,
                    isMine: true,
                },
                {
                    username: b.opponent_username || "Gegner 1",
                    name: b.opponent_display_name || b.opponent_username || "Gegner 1",
                    avatar: oAvatar,
                    score: oScore,
                    isMine: false,
                },
                {
                    username: b.opponent2_username || "Gegner 2",
                    name: b.opponent2_display_name || b.opponent2_username || "Gegner 2",
                    avatar: b.opponent2_avatar_url || "/static/avatar_default.png",
                    score: b.opponent2_score || 0,
                    isMine: false,
                },
            ];
            if (bMode === "1v1v1v1" || b.opponent3_username) {
                players.push({
                    username: b.opponent3_username || "Gegner 3",
                    name: b.opponent3_display_name || b.opponent3_username || "Gegner 3",
                    avatar: b.opponent3_avatar_url || "/static/avatar_default.png",
                    score: b.opponent3_score || 0,
                    isMine: false,
                });
            }

            players.sort((x, y) => (y.score || 0) - (x.score || 0));
            const maxScore = Math.max(1, ...players.map(p => p.score || 0));

            const rankPills = [
                `<span class="rank-pill rank-1">🥇 #1</span>`,
                `<span class="rank-pill rank-2">🥈 #2</span>`,
                `<span class="rank-pill rank-3">🥉 #3</span>`,
                `<span class="rank-pill rank-4">#4</span>`,
            ];

            matchupRowHtml = `
                <div class="battle-ffa-grid">
                    ${players.map((p, idx) => {
                        const rankPill = rankPills[idx] || `<span class="rank-pill">#${idx + 1}</span>`;
                        const pct = Math.round(((p.score || 0) / maxScore) * 100);
                        const isWinnerSlot = idx === 0 && p.score > 0;
                        return `
                            <div class="ffa-player-card ${p.isMine ? 'is-my-streamer' : ''} ${isWinnerSlot ? 'is-winner' : ''}">
                                ${p.isMine ? `<span class="my-streamer-tag">Dein Streamer</span>` : ''}
                                <div style="display:flex; justify-content:space-between; width:100%; align-items:center; margin-bottom:4px;">
                                    ${rankPill}
                                    ${isWinnerSlot ? '<span style="font-size:13px;">👑</span>' : '<span></span>'}
                                </div>
                                <div class="ffa-avatar-wrap">
                                    <img class="ffa-avatar" src="${p.avatar}" alt="${escapeHtml(p.username)}" onerror="this.src='/static/avatar_default.png';">
                                </div>
                                <div class="ffa-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
                                <div class="ffa-uname">@${escapeHtml(p.username)}</div>
                                <div class="ffa-score ${isWinnerSlot ? 'score-win' : ''}">${(p.score || 0).toLocaleString("de-DE")} <span style="font-size:10px; font-weight:600; color:#94a3b8;">Pkt</span></div>
                                <div class="ffa-bar-track" title="${pct}% der Führung">
                                    <div class="ffa-bar-fill" style="width:${pct}%;"></div>
                                </div>
                            </div>
                        `;
                    }).join("")}
                </div>
            `;
        } else if (is2v2) {
            matchupRowHtml = `
                <div class="battle-matchup-row">
                    <!-- Streamer Team (Links) -->
                    <div class="battle-team-column streamer-team">
                        <div class="team-header-row">
                            <span class="muted" style="font-size:11px; font-weight:700;">TEAM STREAMER</span>
                            <span class="team-total-tag ${isWin ? 'score-win' : (isLose ? 'score-lose' : '')}">${sScore.toLocaleString("de-DE")} Pkt</span>
                        </div>
                        <div class="team-roster-wrap">
                            <div class="fighter-chip">
                                <img class="chip-avatar ${isWin ? 'winner-ring' : ''}" src="${sAvatar}" onerror="this.src='/static/avatar_default.png';">
                                <div style="overflow:hidden;">
                                    <div class="chip-name">@${escapeHtml(b.streamer_username)}</div>
                                    <div class="muted" style="font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(b.streamer_display_name || b.streamer_username)}</div>
                                </div>
                            </div>
                            ${b.teammate_username ? `
                            <div class="fighter-chip is-partner">
                                <img class="chip-avatar" src="${b.teammate_avatar_url || '/static/avatar_default.png'}" onerror="this.src='/static/avatar_default.png';">
                                <div style="overflow:hidden;">
                                    <div class="chip-name">@${escapeHtml(b.teammate_username)} <span class="pct-pill" style="font-size:9px; padding:1px 4px;">Partner</span></div>
                                    <div class="muted" style="font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(b.teammate_display_name || b.teammate_username)}</div>
                                </div>
                                ${b.teammate_score ? `<div class="chip-score">${b.teammate_score.toLocaleString("de-DE")}</div>` : ''}
                            </div>
                            ` : ''}
                        </div>
                    </div>

                    <!-- Versus Mitte -->
                    <div class="battle-versus-center">
                        <span class="vs-badge">VS</span>
                        <div class="versus-bar-container" title="${sPct}% vs ${oPct}%">
                            <div class="versus-bar-fill-streamer" style="width:${sPct}%;"></div>
                            <div class="versus-bar-fill-opponent" style="width:${oPct}%;"></div>
                        </div>
                        <span class="score-delta-text">${deltaText} (${sPct}% : ${oPct}%)</span>
                    </div>

                    <!-- Gegner Team (Rechts) -->
                    <div class="battle-team-column opponent-team">
                        <div class="team-header-row" style="justify-content:flex-end;">
                            <span class="team-total-tag ${isLose ? 'score-win' : (isWin ? 'score-lose' : '')}">${oScore.toLocaleString("de-DE")} Pkt</span>
                            <span class="muted" style="font-size:11px; font-weight:700;">TEAM GEGNER</span>
                        </div>
                        <div class="team-roster-wrap">
                            <div class="fighter-chip" style="flex-direction:row-reverse; text-align:right;">
                                <img class="chip-avatar ${isLose ? 'winner-ring' : ''}" src="${oAvatar}" onerror="this.src='/static/avatar_default.png';">
                                <div style="overflow:hidden;">
                                    <div class="chip-name">@${escapeHtml(b.opponent_username || 'Gegner 1')}</div>
                                    <div class="muted" style="font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(b.opponent_display_name || b.opponent_username || 'Gegner 1')}</div>
                                </div>
                            </div>
                            ${b.opponent2_username ? `
                            <div class="fighter-chip is-partner" style="flex-direction:row-reverse; text-align:right;">
                                <img class="chip-avatar" src="${b.opponent2_avatar_url || '/static/avatar_default.png'}" onerror="this.src='/static/avatar_default.png';">
                                <div style="overflow:hidden;">
                                    <div class="chip-name">@${escapeHtml(b.opponent2_username)} <span class="pct-pill" style="font-size:9px; padding:1px 4px;">Partner</span></div>
                                    <div class="muted" style="font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(b.opponent2_display_name || b.opponent2_username)}</div>
                                </div>
                                ${b.opponent2_score ? `<div class="chip-score" style="margin-right:auto; margin-left:0;">${b.opponent2_score.toLocaleString("de-DE")}</div>` : ''}
                            </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
        } else if (isInternal) {
            const sA = b.streamer_a || {};
            const sB = b.streamer_b || {};
            const isWinnerA = Boolean(b.winner_username && b.winner_username === sA.username);
            const isWinnerB = Boolean(b.winner_username && b.winner_username === sB.username);

            matchupRowHtml = `
                <div class="battle-matchup-row">
                    <!-- Streamer A Seite -->
                    <div class="battle-participant streamer-side">
                        <img class="battle-avatar ${isWinnerA ? 'winner-ring' : ''}" src="${sA.avatar_url || sAvatar}" alt="Streamer A" onerror="this.src='/static/avatar_default.png';">
                        <div class="participant-details">
                            <span class="participant-name">${escapeHtml(sA.display_name || sA.username || '')}</span>
                            <span class="participant-uname">@${escapeHtml(sA.username || '')} <span class="internal-streamer-pill">Getrackt</span></span>
                            <span class="participant-score ${isWinnerA ? 'score-win' : ''}">${(sA.score || sScore).toLocaleString("de-DE")}</span>
                            <span class="internal-earnings-tag">+${fmtNum(sA.coins_earned || 0)} 💎 (${fmtEUR(sA.eur_net || 0)})</span>
                        </div>
                    </div>

                    <!-- Versus Mitte -->
                    <div class="battle-versus-center">
                        <span class="vs-badge" style="background:linear-gradient(135deg, #ec4899, #8b5cf6); color:#fff; border:none;">VS</span>
                        <div class="versus-bar-container" title="${sPct}% vs ${oPct}%">
                            <div class="versus-bar-fill-streamer" style="width:${sPct}%; background:#38bdf8;"></div>
                            <div class="versus-bar-fill-opponent" style="width:${oPct}%; background:#ec4899;"></div>
                        </div>
                        <span class="score-delta-text">${deltaText} (${sPct}% : ${oPct}%)</span>
                    </div>

                    <!-- Streamer B Seite -->
                    <div class="battle-participant opponent-side">
                        <div class="participant-details">
                            <span class="participant-name">${escapeHtml(sB.display_name || sB.username || '')}</span>
                            <span class="participant-uname"><span class="internal-streamer-pill">Getrackt</span> @${escapeHtml(sB.username || '')}</span>
                            <span class="participant-score ${isWinnerB ? 'score-win' : ''}">${(sB.score || oScore).toLocaleString("de-DE")}</span>
                            <span class="internal-earnings-tag">+${fmtNum(sB.coins_earned || 0)} 💎 (${fmtEUR(sB.eur_net || 0)})</span>
                        </div>
                        <img class="battle-avatar ${isWinnerB ? 'winner-ring' : ''}" src="${sB.avatar_url || oAvatar}" alt="Streamer B" onerror="this.src='/static/avatar_default.png';">
                    </div>
                </div>
            `;
        } else {
            matchupRowHtml = `
                <div class="battle-matchup-row">
                    <!-- Streamer Seite -->
                    <div class="battle-participant streamer-side">
                        <img class="battle-avatar ${isWin ? 'winner-ring' : (isLose ? 'loser-ring' : '')}" src="${sAvatar}" alt="Streamer" onerror="this.src='/static/avatar_default.png';">
                        <div class="participant-details">
                            <span class="participant-name">${escapeHtml(b.streamer_display_name || b.streamer_username)}</span>
                            <span class="participant-uname">@${escapeHtml(b.streamer_username)}</span>
                            <span class="participant-score ${isWin ? 'score-win' : (isLose ? 'score-lose' : '')}">${sScore.toLocaleString("de-DE")}</span>
                        </div>
                    </div>

                    <!-- Versus Mitte -->
                    <div class="battle-versus-center">
                        <span class="vs-badge">VS</span>
                        <div class="versus-bar-container" title="${sPct}% vs ${oPct}%">
                            <div class="versus-bar-fill-streamer" style="width:${sPct}%;"></div>
                            <div class="versus-bar-fill-opponent" style="width:${oPct}%;"></div>
                        </div>
                        <span class="score-delta-text">${deltaText} (${sPct}% : ${oPct}%)</span>
                    </div>

                    <!-- Gegner Seite -->
                    <div class="battle-participant opponent-side">
                        <div class="participant-details">
                            <span class="participant-name">${escapeHtml(b.opponent_display_name || b.opponent_username || 'Gegner')}</span>
                            <span class="participant-uname">@${escapeHtml(b.opponent_username || 'unbekannt')}</span>
                            <span class="participant-score ${isLose ? 'score-win' : (isWin ? 'score-lose' : '')}">${oScore.toLocaleString("de-DE")}</span>
                        </div>
                        <img class="battle-avatar ${isLose ? 'winner-ring' : (isWin ? 'loser-ring' : '')}" src="${oAvatar}" alt="Opponent" onerror="this.src='/static/avatar_default.png';">
                    </div>
                </div>
            `;
        }

        return `
            <div class="battle-card ${cardClass}">
                <div class="battle-card-header">
                    <div style="display:flex; align-items:center;">
                        ${modeBadge}
                        <span class="battle-meta-time">Duell #${escapeHtml(String(b.battle_id || b.id))} · ${matchDate} · ${durStr}</span>
                    </div>
                    <span class="result-badge ${resultClass}">${resultLabel}</span>
                </div>

                ${matchupRowHtml}

                <!-- MVP Strip -->
                <div class="battle-mvp-strip">
                    <div class="mvp-item">
                        <span class="muted">${isInternal ? 'MVP @' + escapeHtml(b.streamer_a?.username || 'A') + ':' : 'Top-Spender:'}</span>
                        <strong>${escapeHtml((isInternal ? b.streamer_a?.mvp_name : b.streamer_mvp_name) || 'Kein MVP')}</strong>
                        ${(isInternal ? b.streamer_a?.mvp_score : b.streamer_mvp_score) ? `<span class="pct-pill">${(isInternal ? b.streamer_a.mvp_score : b.streamer_mvp_score).toLocaleString("de-DE")} Pkt</span>` : ''}
                    </div>
                    <div class="mvp-item">
                        <span class="muted">${isInternal ? 'MVP @' + escapeHtml(b.streamer_b?.username || 'B') + ':' : 'Gegner-MVP:'}</span>
                        <strong>${escapeHtml((isInternal ? b.streamer_b?.mvp_name : b.opponent_mvp_name) || 'Kein MVP')}</strong>
                        ${(isInternal ? b.streamer_b?.mvp_score : b.opponent_mvp_score) ? `<span class="pct-pill">${(isInternal ? b.streamer_b.mvp_score : b.opponent_mvp_score).toLocaleString("de-DE")} Pkt</span>` : ''}
                    </div>
                </div>

                <!-- Footer mit Einnahmen und Button für Grafik -->
                <div class="battle-card-footer">
                    ${isInternal ? `
                    <div class="battle-earnings-pill" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <span style="font-weight:700; color:#c9d1d9;">🔥 Gesamtvolumen:</span>
                        <span class="coins" style="font-weight:800;">+${(b.total_coins || b.coins_earned || 0).toLocaleString("de-DE")} Coins</span>
                        <span class="eur" style="font-weight:800;">(~ ${(b.total_eur_net || b.eur_net || 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € Netto)</span>
                        <span class="muted" style="font-size:11px; margin-left:auto;">(@${escapeHtml(b.streamer_a?.username || '')}: ${fmtEUR(b.streamer_a?.eur_net || 0)} | @${escapeHtml(b.streamer_b?.username || '')}: ${fmtEUR(b.streamer_b?.eur_net || 0)})</span>
                    </div>
                    ` : `
                    <div class="battle-earnings-pill">
                        <span>Duell-Einnahmen:</span>
                        <span class="coins">+${(b.coins_earned || 0).toLocaleString("de-DE")} Coins</span>
                        <span class="eur">(~ ${(b.eur_net || 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € Netto)</span>
                    </div>
                    `}
                    <div class="battle-btn-group">
                        <button type="button" class="sm primary" onclick="openBattleGraphicModal(${b.id})">🎨 Grafik anzeigen</button>
                    </div>
                </div>
            </div>
        `;
    }).join("");

    // Paginierung
    if (pagination && total > BATTLE_PAGE_SIZE) {
        pagination.style.display = "flex";
        const maxPages = Math.ceil(total / BATTLE_PAGE_SIZE);
        if (pageInfo) pageInfo.textContent = `Seite ${battleCurrentPage + 1} von ${maxPages}`;
        if (prevBtn) prevBtn.disabled = battleCurrentPage === 0;
        if (nextBtn) nextBtn.disabled = battleCurrentPage >= maxPages - 1;
    } else if (pagination) {
        pagination.style.display = "none";
    }
}

async function loadBattleStats() {
    try {
        const params = new URLSearchParams();
        if (battleStreamerId) params.append("streamer_id", battleStreamerId);
        if (battlePeriod) params.append("period", battlePeriod);

        const res = await fetch(`/api/battles/stats?${params.toString()}`);
        if (!res.ok) return;
        const stats = await res.json();

        document.getElementById("kpiTotalBattles").textContent = fmtNum(stats.total_battles || 0);
        document.getElementById("kpiOngoingBattles").textContent = `${stats.ongoing || 0} aktiv`;
        document.getElementById("kpiBattleWinrate").textContent = `${(stats.winrate_pct || 0).toFixed(1)} %`;
        document.getElementById("kpiWinLossDraw").textContent = `${stats.wins || 0}S / ${stats.losses || 0}N / ${stats.draws || 0}U`;
        document.getElementById("kpiBattleNetEur").textContent = fmtEUR(stats.total_eur_net || 0);
        document.getElementById("kpiBattleCoins").textContent = `${fmtNum(stats.total_coins || 0)} Coins`;
        document.getElementById("kpiMaxScore").textContent = `${fmtNum(stats.max_streamer_score || 0)} Pkt`;

        const topRiv = stats.top_opponent;
        if (topRiv) {
            document.getElementById("kpiTopRival").textContent = `@${topRiv.opponent_username}`;
            document.getElementById("kpiTopRivalSub").textContent = `${topRiv.matches_count} Matches (${topRiv.wins}S / ${topRiv.losses}N)`;
        } else {
            document.getElementById("kpiTopRival").textContent = "-";
            document.getElementById("kpiTopRivalSub").textContent = "Keine Duelle";
        }

        renderBattleRivals(stats.rivals || []);
    } catch (e) {
        console.error("Fehler loadBattleStats:", e);
    }
}

function renderBattleRivals(rivals) {
    const tbody = document.getElementById("rivalsTableBody");
    const meta = document.getElementById("rivalsCountMeta");
    if (!tbody) return;

    if (!rivals || rivals.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="muted">Keine Kontrahenten-Daten im gewählten Zeitraum vorhanden.</td></tr>`;
        if (meta) meta.textContent = "0 Rivalen";
        return;
    }

    if (meta) meta.textContent = `${rivals.length} Rivalen ausgewertet`;

    tbody.innerHTML = rivals.map(r => {
        const av = r.opponent_avatar_url || "/static/avatar_default.png";
        const winrate = (r.winrate_pct || 0).toFixed(1);
        const winrateColor = r.winrate_pct >= 50 ? '#10b981' : '#ef4444';

        return `
            <tr>
                <td>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <img src="${av}" alt="Avatar" style="width:28px; height:28px; border-radius:50%; object-fit:cover;" onerror="this.src='/static/avatar_default.png';">
                        <div>
                            <strong>${escapeHtml(r.opponent_display_name || r.opponent_username)}</strong>
                            <div class="muted" style="font-size:11px;">@${escapeHtml(r.opponent_username)}</div>
                        </div>
                    </div>
                </td>
                <td class="num-col"><strong>${r.matches_count}</strong></td>
                <td class="num-col mono hide-sm">${r.wins}S - ${r.losses}N - ${r.draws}U</td>
                <td class="num-col mono" style="font-weight:700; color:${winrateColor};">${winrate} %</td>
                <td class="num-col mono hide-md">${(r.avg_streamer_score || 0).toLocaleString("de-DE")}</td>
                <td class="num-col mono hide-md">${(r.avg_opponent_score || 0).toLocaleString("de-DE")}</td>
                <td class="num-col mono hide-sm" style="color:#f59e0b; font-weight:700;">${fmtNum(r.total_coins || 0)}</td>
                <td class="num-col mono" style="color:#10b981; font-weight:700;">${fmtEUR(r.total_eur_net || 0)}</td>
            </tr>
        `;
    }).join("");
}

async function openBattleGraphicModal(battleId) {
    try {
        const res = await fetch(`/api/battles/${battleId}`);
        if (!res.ok) {
            alert("Battle-Details konnten nicht geladen werden.");
            return;
        }
        const b = await res.json();
        currentSelectedBattle = b;

        const cardContainer = document.getElementById("stylizedBattleCard");
        if (!cardContainer) return;

        const isWin = b.result === "WIN";
        const isLose = b.result === "LOSE";
        const isDraw = b.result === "DRAW";

        let outcomeLabel = "UNENTSCHIEDEN";
        let outcomeClass = "draw";
        if (isWin) {
            outcomeLabel = "VICTORY / SIEG";
            outcomeClass = "win";
        } else if (isLose) {
            outcomeLabel = "DEFEAT / NIEDERLAGE";
            outcomeClass = "lose";
        }

        const sScore = b.streamer_score || 0;
        const oScore = b.opponent_score || 0;
        const totScore = sScore + oScore;
        const sPct = totScore > 0 ? Math.round((sScore / totScore) * 100) : 50;
        const oPct = 100 - sPct;

        const sAvatar = b.streamer_avatar_url || "/static/avatar_default.png";
        const oAvatar = b.opponent_avatar_url || "/static/avatar_default.png";

        const durMins = Math.floor((b.duration_seconds || 300) / 60);
        const durSecs = (b.duration_seconds || 300) % 60;
        const durStr = `${String(durMins).padStart(2, "0")}:${String(durSecs).padStart(2, "0")} Min`;

        const matchDate = b.started_at ? b.started_at.replace("T", " ").substring(0, 16) : "-";

        const bMode = b.battle_mode || "1v1";
        const isFfa = bMode === "1v1v1" || bMode === "1v1v1v1";
        const is2v2 = bMode === "2v2" || !!b.teammate_username;

        let brandTitle = "⚔️ TIKTOK LIVE MATCHUP · TOKTRACKER";
        if (bMode === "2v2") {
            brandTitle = "⚔️ TIKTOK 2 VS 2 TEAM BATTLE · TOKTRACKER";
        } else if (bMode === "1v1v1") {
            brandTitle = "⚔️ TIKTOK 1 VS 1 VS 1 (3ER-MATCH) · TOKTRACKER";
        } else if (bMode === "1v1v1v1") {
            brandTitle = "⚔️ TIKTOK 4ER-EINZELMATCH (1V1V1V1) · TOKTRACKER";
        }

        let arenaHtml = "";
        if (isFfa) {
            const players = [
                {
                    username: b.streamer_username,
                    name: b.streamer_display_name || b.streamer_username,
                    avatar: sAvatar,
                    score: sScore,
                    isMine: true,
                },
                {
                    username: b.opponent_username || "Gegner 1",
                    name: b.opponent_display_name || b.opponent_username || "Gegner 1",
                    avatar: oAvatar,
                    score: oScore,
                    isMine: false,
                },
                {
                    username: b.opponent2_username || "Gegner 2",
                    name: b.opponent2_display_name || b.opponent2_username || "Gegner 2",
                    avatar: b.opponent2_avatar_url || "/static/avatar_default.png",
                    score: b.opponent2_score || 0,
                    isMine: false,
                },
            ];
            if (bMode === "1v1v1v1" || b.opponent3_username) {
                players.push({
                    username: b.opponent3_username || "Gegner 3",
                    name: b.opponent3_display_name || b.opponent3_username || "Gegner 3",
                    avatar: b.opponent3_avatar_url || "/static/avatar_default.png",
                    score: b.opponent3_score || 0,
                    isMine: false,
                });
            }

            players.sort((x, y) => (y.score || 0) - (x.score || 0));
            const maxScore = Math.max(1, ...players.map(p => p.score || 0));

            const rankPills = [
                `<span class="rank-pill rank-1">🥇 #1 PLATZ</span>`,
                `<span class="rank-pill rank-2">🥈 #2 PLATZ</span>`,
                `<span class="rank-pill rank-3">🥉 #3 PLATZ</span>`,
                `<span class="rank-pill rank-4">#4 PLATZ</span>`,
            ];

            arenaHtml = `
            <div class="stylized-ffa-arena">
                ${players.map((p, idx) => {
                    const rankPill = rankPills[idx] || `<span class="rank-pill">#${idx + 1}</span>`;
                    const pct = Math.round(((p.score || 0) / maxScore) * 100);
                    const isWinnerSlot = idx === 0 && p.score > 0;
                    return `
                        <div class="stylized-ffa-slot ${isWinnerSlot ? 'is-first' : ''} ${p.isMine ? 'is-my-streamer' : ''}">
                            <div style="margin-bottom:6px;">
                                ${rankPill}
                            </div>
                            <div class="stylized-avatar-wrap">
                                ${isWinnerSlot ? '<div class="stylized-crown">👑</div>' : ''}
                                <img class="stylized-avatar ${isWinnerSlot ? 'winner-glow' : ''}" style="width:64px; height:64px;" src="${p.avatar}" alt="${escapeHtml(p.username)}" onerror="this.src='/static/avatar_default.png';">
                            </div>
                            <div class="stylized-name" style="font-size:13px; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(p.name)}</div>
                            <div class="stylized-uname" style="font-size:11px;">@${escapeHtml(p.username)}</div>
                            <div class="stylized-score-digits ${isWinnerSlot ? 'score-win' : ''}" style="font-size:22px; margin:6px 0;">${(p.score || 0).toLocaleString("de-DE")}</div>
                            <div class="ffa-bar-track" style="width:100%; height:6px;">
                                <div class="ffa-bar-fill" style="width:${pct}%;"></div>
                            </div>
                        </div>
                    `;
                }).join("")}
            </div>
            `;
        } else if (is2v2) {
            arenaHtml = `
            <div class="stylized-matchup-arena is-2v2">
                <!-- Streamer Team (Blau) -->
                <div class="stylized-duo-column streamer-side">
                    <div style="font-size:11px; font-weight:800; color:#3b82f6; text-transform:uppercase; letter-spacing:0.05em;">TEAM STREAMER</div>
                    <div class="stylized-fighters-pair">
                        <div class="stylized-chip-player">
                            <div class="stylized-avatar-wrap">
                                ${isWin ? '<div class="stylized-crown">👑</div>' : ''}
                                <img class="stylized-avatar ${isWin ? 'winner-glow' : ''}" style="width:60px; height:60px;" src="${sAvatar}" alt="Streamer" onerror="this.src='/static/avatar_default.png';">
                            </div>
                            <div class="stylized-name" style="font-size:13px; max-width:96px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(b.streamer_display_name || b.streamer_username)}</div>
                            <div class="stylized-uname" style="font-size:11px;">@${escapeHtml(b.streamer_username)}</div>
                        </div>
                        <div class="stylized-chip-player">
                            <div class="stylized-avatar-wrap">
                                ${isWin ? '<div class="stylized-crown">👑</div>' : ''}
                                <img class="stylized-avatar ${isWin ? 'winner-glow' : ''}" style="width:60px; height:60px;" src="${b.teammate_avatar_url || '/static/avatar_default.png'}" alt="Partner" onerror="this.src='/static/avatar_default.png';">
                            </div>
                            <div class="stylized-name" style="font-size:13px; max-width:96px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(b.teammate_display_name || b.teammate_username || 'Partner')}</div>
                            <div class="stylized-uname" style="font-size:11px;">@${escapeHtml(b.teammate_username || 'partner')}</div>
                        </div>
                    </div>
                    <div class="stylized-score-digits ${isWin ? 'score-win' : (isLose ? 'score-lose' : '')}" style="font-size:28px;">${sScore.toLocaleString("de-DE")} <span style="font-size:11px; font-weight:600; color:#94a3b8;">Team-Punkte</span></div>
                </div>

                <!-- Center Stage -->
                <div class="stylized-center-stage">
                    <div class="stylized-vs-symbol">VS</div>
                    <div class="stylized-outcome-banner ${outcomeClass}">${outcomeLabel}</div>
                    <div class="stylized-bar-wrapper">
                        <div class="stylized-bar">
                            <div class="stylized-bar-streamer" style="width:${sPct}%;"></div>
                            <div class="stylized-bar-opponent" style="width:${oPct}%;"></div>
                        </div>
                        <div style="font-size:11px; text-align:center; font-family:'JetBrains Mono', Consolas, monospace; color:#94a3b8;">
                            ${sPct}% : ${oPct}% · Differenz: ${Math.abs(sScore - oScore).toLocaleString("de-DE")} Pkt
                        </div>
                    </div>
                </div>

                <!-- Gegner Team (Rot) -->
                <div class="stylized-duo-column opponent-side">
                    <div style="font-size:11px; font-weight:800; color:#ef4444; text-transform:uppercase; letter-spacing:0.05em;">TEAM GEGNER</div>
                    <div class="stylized-fighters-pair">
                        <div class="stylized-chip-player">
                            <div class="stylized-avatar-wrap">
                                ${isLose ? '<div class="stylized-crown">👑</div>' : ''}
                                <img class="stylized-avatar ${isLose ? 'winner-glow' : ''}" style="width:60px; height:60px;" src="${oAvatar}" alt="Gegner" onerror="this.src='/static/avatar_default.png';">
                            </div>
                            <div class="stylized-name" style="font-size:13px; max-width:96px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(b.opponent_display_name || b.opponent_username || 'Gegner')}</div>
                            <div class="stylized-uname" style="font-size:11px;">@${escapeHtml(b.opponent_username || 'gegner')}</div>
                        </div>
                        <div class="stylized-chip-player">
                            <div class="stylized-avatar-wrap">
                                ${isLose ? '<div class="stylized-crown">👑</div>' : ''}
                                <img class="stylized-avatar ${isLose ? 'winner-glow' : ''}" style="width:60px; height:60px;" src="${b.opponent2_avatar_url || '/static/avatar_default.png'}" alt="Gegner 2" onerror="this.src='/static/avatar_default.png';">
                            </div>
                            <div class="stylized-name" style="font-size:13px; max-width:96px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(b.opponent2_display_name || b.opponent2_username || 'Gegner 2')}</div>
                            <div class="stylized-uname" style="font-size:11px;">@${escapeHtml(b.opponent2_username || 'gegner2')}</div>
                        </div>
                    </div>
                    <div class="stylized-score-digits ${isLose ? 'score-win' : (isWin ? 'score-lose' : '')}" style="font-size:28px;">${oScore.toLocaleString("de-DE")} <span style="font-size:11px; font-weight:600; color:#94a3b8;">Team-Punkte</span></div>
                </div>
            </div>
            `;
        } else {
            arenaHtml = `
            <div class="stylized-matchup-arena">
                <!-- Streamer -->
                <div class="stylized-fighter">
                    <div class="stylized-avatar-wrap">
                        ${isWin ? '<div class="stylized-crown">👑</div>' : ''}
                        <img class="stylized-avatar ${isWin ? 'winner-glow' : ''}" src="${sAvatar}" alt="Streamer" onerror="this.src='/static/avatar_default.png';">
                    </div>
                    <div class="stylized-name">${escapeHtml(b.streamer_display_name || b.streamer_username)}</div>
                    <div class="stylized-uname">@${escapeHtml(b.streamer_username)}</div>
                    <div class="stylized-score-digits ${isWin ? 'score-win' : (isLose ? 'score-lose' : '')}">${sScore.toLocaleString("de-DE")}</div>
                </div>

                <!-- Center -->
                <div class="stylized-center-stage">
                    <div class="stylized-vs-symbol">VS</div>
                    <div class="stylized-outcome-banner ${outcomeClass}">${outcomeLabel}</div>
                    <div class="stylized-bar-wrapper">
                        <div class="stylized-bar">
                            <div class="stylized-bar-streamer" style="width:${sPct}%;"></div>
                            <div class="stylized-bar-opponent" style="width:${oPct}%;"></div>
                        </div>
                        <div style="font-size:11px; text-align:center; font-family:'JetBrains Mono', Consolas, monospace; color:#94a3b8;">
                            ${sPct}% : ${oPct}% · Differenz: ${Math.abs(sScore - oScore).toLocaleString("de-DE")} Pkt
                        </div>
                    </div>
                </div>

                <!-- Gegner -->
                <div class="stylized-fighter">
                    <div class="stylized-avatar-wrap">
                        ${isLose ? '<div class="stylized-crown">👑</div>' : ''}
                        <img class="stylized-avatar ${isLose ? 'winner-glow' : ''}" src="${oAvatar}" alt="Gegner" onerror="this.src='/static/avatar_default.png';">
                    </div>
                    <div class="stylized-name">${escapeHtml(b.opponent_display_name || b.opponent_username || 'Gegner')}</div>
                    <div class="stylized-uname">@${escapeHtml(b.opponent_username || 'unbekannt')}</div>
                    <div class="stylized-score-digits ${isLose ? 'score-win' : (isWin ? 'score-lose' : '')}">${oScore.toLocaleString("de-DE")}</div>
                </div>
            </div>
            `;
        }

        cardContainer.innerHTML = `
            <div class="stylized-battle-header">
                <span class="stylized-brand">${brandTitle}</span>
                <span class="stylized-time">${matchDate} · ${durStr}</span>
            </div>

            ${arenaHtml}

            <!-- MVP Deck -->
            <div class="stylized-mvp-deck">
                <div class="stylized-mvp-card">
                    <div>
                        <div class="stylized-mvp-label">★ Streamer MVP</div>
                        <div class="stylized-mvp-name">${escapeHtml(b.streamer_mvp_name ? '@' + b.streamer_mvp_name : 'Kein Spender erfasst')}</div>
                        ${b.streamer_mvp_score ? `<div class="stylized-mvp-score">${b.streamer_mvp_score.toLocaleString("de-DE")} Punkte</div>` : ''}
                    </div>
                </div>
                <div class="stylized-mvp-card right">
                    <div>
                        <div class="stylized-mvp-label">Gegner MVP ★</div>
                        <div class="stylized-mvp-name">${escapeHtml(b.opponent_mvp_name ? '@' + b.opponent_mvp_name : 'Kein Spender erfasst')}</div>
                        ${b.opponent_mvp_score ? `<div class="stylized-mvp-score">${b.opponent_mvp_score.toLocaleString("de-DE")} Punkte</div>` : ''}
                    </div>
                </div>
            </div>

            <!-- Footer Stats -->
            <div class="stylized-footer-stats">
                <div>
                    Duell-Einnahmen: <span class="stylized-reward-badge">+${(b.coins_earned || 0).toLocaleString("de-DE")} Coins</span>
                    <span style="color:#34d399; font-weight:700; margin-left:6px;">(~ ${(b.eur_net || 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € Netto)</span>
                </div>
                <div style="color:#64748b;">Battle-ID: #${escapeHtml(String(b.battle_id))}</div>
            </div>
        `;

        // Render Gifts during match
        const giftsContainer = document.getElementById("battleModalGiftsContainer");
        const giftsList = document.getElementById("battleModalGiftsList");
        if (giftsContainer && giftsList) {
            const gifts = b.gifts || [];
            if (gifts.length > 0) {
                giftsContainer.style.display = "block";
                giftsList.innerHTML = gifts.map(g => {
                    const icon = g.gift_icon_url ? `<img src="${g.gift_icon_url}" alt="gift">` : '';
                    return `
                        <div class="battle-gift-pill">
                            ${icon}
                            <strong>${g.repeat_count}x ${escapeHtml(g.gift_name)}</strong>
                            <span class="muted">(@${escapeHtml(g.sender_username)})</span>
                            <span style="color:#f59e0b; font-weight:700;">${g.total_coins.toLocaleString("de-DE")} C</span>
                        </div>
                    `;
                }).join("");
            } else {
                giftsContainer.style.display = "none";
                giftsList.innerHTML = "";
            }
        }

        const modal = document.getElementById("modalBattleGraphic");
        if (modal) modal.style.display = "flex";
    } catch (e) {
        console.error("Fehler openBattleGraphicModal:", e);
    }
}

function closeBattleGraphicModal() {
    const modal = document.getElementById("modalBattleGraphic");
    if (modal) modal.style.display = "none";
    currentSelectedBattle = null;
}

function downloadBattleGraphicPng() {
    if (!currentSelectedBattle) return;
    const b = currentSelectedBattle;
    const canvas = document.getElementById("battleExportCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 960;
    const H = 540;
    canvas.width = W;
    canvas.height = H;

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, "#090d16");
    bgGrad.addColorStop(0.5, "#15192c");
    bgGrad.addColorStop(1, "#0d121f");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Neon Border
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#3b82f6";
    ctx.strokeRect(10, 10, W - 20, H - 20);

    const bMode = b.battle_mode || "1v1";
    const isFfa = bMode === "1v1v1" || bMode === "1v1v1v1";
    const is2v2 = bMode === "2v2" || !!b.teammate_username;

    // Top Header Banner
    let bannerTitle = "TOKTRACKER // TIKTOK LIVE BATTLE MATCHUP";
    if (bMode === "2v2") {
        bannerTitle = "TOKTRACKER // 2 VS 2 TEAM BATTLE MATCHUP";
    } else if (bMode === "1v1v1") {
        bannerTitle = "TOKTRACKER // 1 VS 1 VS 1 (3ER-MATCH) FFA LEADERBOARD";
    } else if (bMode === "1v1v1v1") {
        bannerTitle = "TOKTRACKER // 4ER-EINZELMATCH (1V1V1V1) FFA LEADERBOARD";
    }

    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 13px 'JetBrains Mono', Consolas, monospace";
    ctx.textAlign = "left";
    ctx.fillText(bannerTitle, 30, 42);

    const matchDate = b.started_at ? b.started_at.replace("T", " ") : "";
    const durMins = Math.floor((b.duration_seconds || 300) / 60);
    const durSecs = (b.duration_seconds || 300) % 60;
    const durStr = `${String(durMins).padStart(2, "0")}:${String(durSecs).padStart(2, "0")} Min`;

    ctx.textAlign = "right";
    ctx.fillText(`${matchDate} · ${durStr}`, W - 30, 42);

    // Divider line
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 56);
    ctx.lineTo(W - 30, 56);
    ctx.stroke();

    if (isFfa) {
        // Free-for-all Podium Canvas Export (3er oder 4er-Einzel)
        const players = [
            {
                username: b.streamer_username,
                name: b.streamer_display_name || b.streamer_username,
                score: b.streamer_score || 0,
                isMine: true,
            },
            {
                username: b.opponent_username || "Gegner 1",
                name: b.opponent_display_name || b.opponent_username || "Gegner 1",
                score: b.opponent_score || 0,
                isMine: false,
            },
            {
                username: b.opponent2_username || "Gegner 2",
                name: b.opponent2_display_name || b.opponent2_username || "Gegner 2",
                score: b.opponent2_score || 0,
                isMine: false,
            },
        ];
        if (bMode === "1v1v1v1" || b.opponent3_username) {
            players.push({
                username: b.opponent3_username || "Gegner 3",
                name: b.opponent3_display_name || b.opponent3_username || "Gegner 3",
                score: b.opponent3_score || 0,
                isMine: false,
            });
        }
        players.sort((x, y) => (y.score || 0) - (x.score || 0));
        const maxScore = Math.max(1, ...players.map(p => p.score || 0));

        // Result Tag
        const streamerRank = b.streamer_rank || (b.result === "WIN" ? 1 : 2);
        let outcomeText = "UNENTSCHIEDEN";
        let outcomeColor = "#f59e0b";
        let outcomeBg = "rgba(245, 158, 11, 0.3)";
        if (streamerRank === 1 && b.result === "WIN") {
            outcomeText = "🥇 1. PLATZ // SIEG";
            outcomeColor = "#34d399";
            outcomeBg = "rgba(16, 185, 129, 0.35)";
        } else if (streamerRank === 2) {
            outcomeText = "🥈 2. PLATZ";
            outcomeColor = "#94a3b8";
            outcomeBg = "rgba(148, 163, 184, 0.3)";
        } else if (streamerRank === 3) {
            outcomeText = "🥉 3. PLATZ";
            outcomeColor = "#fb923c";
            outcomeBg = "rgba(251, 146, 60, 0.3)";
        } else if (streamerRank === 4) {
            outcomeText = "4. PLATZ";
            outcomeColor = "#64748b";
            outcomeBg = "rgba(100, 116, 139, 0.3)";
        }

        ctx.textAlign = "center";
        ctx.fillStyle = outcomeBg;
        ctx.fillRect(W / 2 - 120, 72, 240, 32);
        ctx.strokeStyle = outcomeColor;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(W / 2 - 120, 72, 240, 32);
        ctx.fillStyle = outcomeColor;
        ctx.font = "bold 14px 'JetBrains Mono', Consolas, monospace";
        ctx.fillText(outcomeText, W / 2, 93);

        const N = players.length;
        const totalPad = 60;
        const gap = 16;
        const slotW = Math.floor((W - totalPad * 2 - (N - 1) * gap) / N);
        const cardY = 120;
        const cardH = 190;

        players.forEach((p, idx) => {
            const slotX = totalPad + idx * (slotW + gap);
            const slotCenter = slotX + slotW / 2;

            // Box Background
            ctx.fillStyle = p.isMine ? "rgba(59, 130, 246, 0.12)" : "rgba(255, 255, 255, 0.04)";
            ctx.fillRect(slotX, cardY, slotW, cardH);
            ctx.lineWidth = p.isMine ? 2 : 1;
            ctx.strokeStyle = p.isMine ? "#3b82f6" : (idx === 0 ? "#facc15" : "rgba(255, 255, 255, 0.12)");
            ctx.strokeRect(slotX, cardY, slotW, cardH);

            // Rank Badge
            let rankColor = "#94a3b8";
            if (idx === 0) rankColor = "#facc15";
            else if (idx === 1) rankColor = "#e2e8f0";
            else if (idx === 2) rankColor = "#fdba74";

            ctx.fillStyle = rankColor;
            ctx.font = "bold 13px 'JetBrains Mono', monospace";
            ctx.fillText(`#${idx + 1} PLATZ`, slotCenter, cardY + 26);

            if (idx === 0) {
                ctx.font = "22px sans-serif";
                ctx.fillText("👑", slotCenter, cardY + 54);
            }

            // Name & Uname
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 15px sans-serif";
            const truncName = p.name.length > 13 ? p.name.slice(0, 12) + "…" : p.name;
            ctx.fillText(truncName, slotCenter, cardY + 84);

            ctx.fillStyle = "#94a3b8";
            ctx.font = "12px 'JetBrains Mono', monospace";
            ctx.fillText(`@${p.username}`, slotCenter, cardY + 104);

            // Score digits
            ctx.fillStyle = idx === 0 ? "#facc15" : (p.isMine ? "#60a5fa" : "#ffffff");
            ctx.font = "bold 26px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText((p.score || 0).toLocaleString("de-DE"), slotCenter, cardY + 144);

            // Score progress bar
            const barPct = (p.score || 0) / maxScore;
            const bPad = 16;
            ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
            ctx.fillRect(slotX + bPad, cardY + 162, slotW - bPad * 2, 6);
            ctx.fillStyle = idx === 0 ? "#facc15" : "#3b82f6";
            ctx.fillRect(slotX + bPad, cardY + 162, (slotW - bPad * 2) * barPct, 6);

            if (p.isMine) {
                ctx.fillStyle = "#3b82f6";
                ctx.font = "bold 10px 'JetBrains Mono', monospace";
                ctx.fillText("★ DEIN STREAMER ★", slotCenter, cardY + 182);
            }
        });
    } else {
        // Center VS Symbol & Result Banner (1v1 oder 2v2)
        ctx.textAlign = "center";
        ctx.font = "italic 900 42px sans-serif";
        ctx.fillStyle = "#60a5fa";
        ctx.fillText("VS", W / 2, 160);

        // Outcome Pill
        let outcomeText = "UNENTSCHIEDEN";
        let outcomeColor = "#f59e0b";
        let outcomeBg = "rgba(245, 158, 11, 0.3)";
        if (b.result === "WIN") {
            outcomeText = "VICTORY / SIEG";
            outcomeColor = "#34d399";
            outcomeBg = "rgba(16, 185, 129, 0.35)";
        } else if (b.result === "LOSE") {
            outcomeText = "DEFEAT / NIEDERLAGE";
            outcomeColor = "#f87171";
            outcomeBg = "rgba(239, 68, 68, 0.35)";
        } else if (b.result === "ONGOING") {
            outcomeText = "LIVE MATCH";
            outcomeColor = "#60a5fa";
            outcomeBg = "rgba(59, 130, 246, 0.35)";
        }

        ctx.fillStyle = outcomeBg;
        ctx.fillRect(W / 2 - 100, 185, 200, 32);
        ctx.strokeStyle = outcomeColor;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(W / 2 - 100, 185, 200, 32);
        ctx.fillStyle = outcomeColor;
        ctx.font = "bold 14px 'JetBrains Mono', Consolas, monospace";
        ctx.fillText(outcomeText, W / 2, 206);

        const sName = b.streamer_display_name || b.streamer_username;
        const sUname = `@${b.streamer_username}`;
        const sScore = (b.streamer_score || 0).toLocaleString("de-DE");

        const oName = b.opponent_display_name || b.opponent_username || "Gegner";
        const oUname = b.opponent_username ? `@${b.opponent_username}` : "-";
        const oScore = (b.opponent_score || 0).toLocaleString("de-DE");

        if (is2v2) {
            // Left Side: Streamer Team (2 Fighters)
            ctx.textAlign = "center";
            ctx.fillStyle = "#60a5fa";
            ctx.font = "bold 12px 'JetBrains Mono', monospace";
            ctx.fillText("TEAM STREAMER", 220, 100);

            // Fighter 1 (Main Streamer)
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 16px sans-serif";
            ctx.fillText(sName.length > 14 ? sName.slice(0, 13) + "…" : sName, 140, 132);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "12px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(sUname, 140, 154);

            // Fighter 2 (Teammate)
            const tName = b.teammate_display_name || b.teammate_username || "Partner";
            const tUname = `@${b.teammate_username || "partner"}`;
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 16px sans-serif";
            ctx.fillText(tName.length > 14 ? tName.slice(0, 13) + "…" : tName, 300, 132);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "12px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(tUname, 300, 154);

            // Combined Team Score
            ctx.fillStyle = b.result === "WIN" ? "#34d399" : (b.result === "LOSE" ? "#94a3b8" : "#ffffff");
            ctx.font = "bold 40px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(sScore, 220, 218);
            ctx.font = "bold 11px 'JetBrains Mono', monospace";
            ctx.fillStyle = "#94a3b8";
            ctx.fillText("TEAM-GESAMT", 220, 238);

            if (b.result === "WIN") {
                ctx.font = "28px sans-serif";
                ctx.fillText("👑", 220, 78);
            }

            // Right Side: Opponent Team (2 Fighters)
            ctx.fillStyle = "#f87171";
            ctx.font = "bold 12px 'JetBrains Mono', monospace";
            ctx.fillText("TEAM GEGNER", W - 220, 100);

            // Opponent 1
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 16px sans-serif";
            ctx.fillText(oName.length > 14 ? oName.slice(0, 13) + "…" : oName, W - 300, 132);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "12px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(oUname, W - 300, 154);

            // Opponent 2
            const o2Name = b.opponent2_display_name || b.opponent2_username || "Gegner 2";
            const o2Uname = `@${b.opponent2_username || "gegner2"}`;
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 16px sans-serif";
            ctx.fillText(o2Name.length > 14 ? o2Name.slice(0, 13) + "…" : o2Name, W - 140, 132);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "12px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(o2Uname, W - 140, 154);

            // Opponent Combined Team Score
            ctx.fillStyle = b.result === "LOSE" ? "#34d399" : (b.result === "WIN" ? "#94a3b8" : "#ffffff");
            ctx.font = "bold 40px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(oScore, W - 220, 218);
            ctx.font = "bold 11px 'JetBrains Mono', monospace";
            ctx.fillStyle = "#94a3b8";
            ctx.fillText("TEAM-GESAMT", W - 220, 238);

            if (b.result === "LOSE") {
                ctx.font = "28px sans-serif";
                ctx.fillText("👑", W - 220, 78);
            }
        } else {
            // Left Side: Streamer (1v1)
            ctx.textAlign = "center";
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 24px sans-serif";
            ctx.fillText(sName, 220, 140);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "14px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(sUname, 220, 168);

            // Score digits
            ctx.fillStyle = b.result === "WIN" ? "#34d399" : (b.result === "LOSE" ? "#94a3b8" : "#ffffff");
            ctx.font = "bold 44px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(sScore, 220, 225);

            if (b.result === "WIN") {
                ctx.font = "34px sans-serif";
                ctx.fillText("👑", 220, 100);
            }

            // Right Side: Opponent (1v1)
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 24px sans-serif";
            ctx.fillText(oName, W - 220, 140);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "14px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(oUname, W - 220, 168);

            // Score digits
            ctx.fillStyle = b.result === "LOSE" ? "#34d399" : (b.result === "WIN" ? "#94a3b8" : "#ffffff");
            ctx.font = "bold 44px 'JetBrains Mono', Consolas, monospace";
            ctx.fillText(oScore, W - 220, 225);

            if (b.result === "LOSE") {
                ctx.font = "34px sans-serif";
                ctx.fillText("👑", W - 220, 100);
            }
        }

        // Versus Score Bar (Center, nur für 1v1 und 2v2)
        const totScore = (b.streamer_score || 0) + (b.opponent_score || 0);
        const sPct = totScore > 0 ? (b.streamer_score / totScore) : 0.5;
        const barW = 540;
        const barX = (W - barW) / 2;
        const barY = 270;
        const barH = 16;

        ctx.fillStyle = "#1e293b";
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = "#10b981";
        ctx.fillRect(barX, barY, barW * sPct, barH);
        ctx.fillStyle = "#ef4444";
        ctx.fillRect(barX + barW * sPct, barY, barW * (1 - sPct), barH);
    }

    // MVPs Section
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.moveTo(30, 330);
    ctx.lineTo(W - 30, 330);
    ctx.stroke();

    // Streamer MVP
    ctx.textAlign = "left";
    ctx.fillStyle = "#f59e0b";
    ctx.font = "bold 12px 'JetBrains Mono', monospace";
    ctx.fillText("★ STREAMER MVP SUPPORTER", 40, 360);
    ctx.fillStyle = "#f1f5f9";
    ctx.font = "bold 16px sans-serif";
    ctx.fillText(b.streamer_mvp_name ? `@${b.streamer_mvp_name}` : "Kein MVP erfasst", 40, 386);
    if (b.streamer_mvp_score) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "13px 'JetBrains Mono', monospace";
        ctx.fillText(`${b.streamer_mvp_score.toLocaleString("de-DE")} Punkte beigesteuert`, 40, 410);
    }

    // Opponent MVP
    ctx.textAlign = "right";
    ctx.fillStyle = "#f59e0b";
    ctx.font = "bold 12px 'JetBrains Mono', monospace";
    ctx.fillText("RIVAL MVP SUPPORTER ★", W - 40, 360);
    ctx.fillStyle = "#f1f5f9";
    ctx.font = "bold 16px sans-serif";
    ctx.fillText(b.opponent_mvp_name ? `@${b.opponent_mvp_name}` : "Kein MVP erfasst", W - 40, 386);
    if (b.opponent_mvp_score) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "13px 'JetBrains Mono', monospace";
        ctx.fillText(`${b.opponent_mvp_score.toLocaleString("de-DE")} Punkte beigesteuert`, W - 40, 410);
    }

    // Footer Strip: Earned Coins & Netto EUR
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.moveTo(30, 450);
    ctx.lineTo(W - 30, 450);
    ctx.stroke();

    const coinsEarned = (b.coins_earned || 0).toLocaleString("de-DE");
    const eurNet = (b.eur_net || 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ctx.textAlign = "left";
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "bold 14px 'JetBrains Mono', monospace";
    ctx.fillText(`Duell-Einnahmen: ${coinsEarned} Coins  (~ ${eurNet} € Netto-Auszahlung)`, 40, 490);

    ctx.textAlign = "right";
    ctx.fillStyle = "#64748b";
    ctx.font = "12px 'JetBrains Mono', monospace";
    ctx.fillText(`Battle ID: #${b.battle_id}`, W - 40, 490);

    // Export image download
    const link = document.createElement("a");
    link.download = `tiktok_battle_${b.battle_id || b.id}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
}


document.addEventListener("DOMContentLoaded", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(currentTheme);

    const themeBtn = document.getElementById("btnThemeToggle");
    if (themeBtn) {
        themeBtn.addEventListener("click", () => {
            const nextTheme =
                document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
            applyTheme(nextTheme);
        });
    }

    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            switchTab(btn.getAttribute("data-tab"));
        });
    });

    loadOverview();
    let overviewTimer = null;
    function scheduleNextOverview() {
        if (overviewTimer) clearTimeout(overviewTimer);
        const delay = document.hidden ? 30000 : 5000;
        overviewTimer = setTimeout(async () => {
            if (!document.hidden) {
                await loadOverview();
                if (document.getElementById("tab-battles")?.classList.contains("active")) {
                    loadBattles(true);
                    loadBattleStats();
                }
            }
            scheduleNextOverview();
        }, delay);
    }
    scheduleNextOverview();

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            loadOverview();
            scheduleNextOverview();
        }
    });

    document.getElementById("periodSelect").addEventListener("change", (e) => {
        currentPeriod = e.target.value;
        loadOverview();
    });

    document.getElementById("selectAnalyticsStreamer")?.addEventListener("change", (e) => {
        analyticsStreamerId = e.target.value;
        lastAnalyticsFingerprint = null;
        loadAnalytics();
    });

    document.getElementById("selectAnalyticsPeriod")?.addEventListener("change", (e) => {
        analyticsPeriod = e.target.value;
        lastAnalyticsFingerprint = null;
        loadAnalytics();
    });

    document.getElementById("btnRefreshAnalytics")?.addEventListener("click", () => {
        lastAnalyticsFingerprint = null;
        loadAnalytics();
    });

    document.getElementById("btnTimelineToggleMetric")?.addEventListener("click", () => {
        lastAnalyticsFingerprint = null;
        toggleTimelineMetric();
    });

    // Auto-Refresh (30s) Steuerung
    const chkAutoRefresh = document.getElementById("chkAnalyticsAutoRefresh");
    if (chkAutoRefresh) {
        chkAutoRefresh.addEventListener("change", () => {
            if (chkAutoRefresh.checked) {
                if (analyticsAutoRefreshTimer) clearInterval(analyticsAutoRefreshTimer);
                analyticsAutoRefreshTimer = setInterval(() => {
                    if (document.getElementById("tab-analytics")?.classList.contains("active") && chkAutoRefresh.checked) {
                        loadAnalytics(true);
                    }
                }, 30000);
                loadAnalytics(true);
            } else {
                if (analyticsAutoRefreshTimer) {
                    clearInterval(analyticsAutoRefreshTimer);
                    analyticsAutoRefreshTimer = null;
                }
            }
        });
    }

    document.getElementById("btnRefresh").addEventListener("click", loadOverview);

    document.getElementById("inputStreamerFilter").addEventListener("input", renderStreamerTable);
    document.getElementById("inputGiftFilter").addEventListener("input", renderGiftLog);
    document.getElementById("selectLogSource").addEventListener("change", renderServiceLogs);

    document.getElementById("btnSendTelegramReport").addEventListener("click", async () => {
        const res = await fetch("/api/v1/telegram/send-report?hours=24", { method: "POST" });
        const data = await res.json();
        if (res.ok) {
            alert(`24h-Bericht erfolgreich an Telegram (Chat ${data.chat_id}) gesendet!`);
        } else {
            alert(`Telegram-Versand Hinweis:\n${data.detail || "Bot nicht aktiv"}`);
        }
        loadOverview();
    });

    document.getElementById("selectTelegramMode").addEventListener("change", async (e) => {
        const newMode = e.target.value;
        await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ telegram_access_mode: newMode }),
        });
        loadOverview();
    });

    document.getElementById("formAddTelegramUser").addEventListener("submit", async (e) => {
        e.preventDefault();
        const identInput = document.getElementById("inputTgIdentifier");
        const nameInput = document.getElementById("inputTgName");
        const roleSelect = document.getElementById("selectTgRole");

        const res = await fetch("/api/v1/telegram/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                identifier: identInput.value,
                first_name: nameInput.value || null,
                role: roleSelect.value,
                is_allowed: 1,
                note: "Über Web-Konsole freigeschaltet",
            }),
        });
        if (res.ok) {
            identInput.value = "";
            nameInput.value = "";
            loadOverview();
        }
    });

    document.getElementById("btnCloseDetail").addEventListener("click", () => {
        document.getElementById("streamerDetailBox").style.display = "none";
    });

    document.getElementById("formAddStreamer").addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("inputUsername");
        const displayInput = document.getElementById("inputDisplayName");
        const autoTrack = document.getElementById("checkAutoTrack").checked;
        const autoReconnect = document.getElementById("checkAutoReconnect").checked;
        const res = await fetch("/api/streamers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: input.value,
                display_name: displayInput.value || null,
                auto_track: autoTrack,
                auto_reconnect: autoReconnect,
            }),
        });
        if (res.ok) {
            input.value = "";
            displayInput.value = "";
            loadOverview();
        }
    });

    document.getElementById("formSimulateGift").addEventListener("submit", async (e) => {
        e.preventDefault();
        const streamerId = document.getElementById("simStreamerSelect").value;
        const giftSel = document.getElementById("simGiftSelect");
        const opt = giftSel.options[giftSel.selectedIndex];
        const diamonds = parseInt(opt.getAttribute("data-diamonds") || "1", 10);
        const repeatCount = parseInt(document.getElementById("simRepeatCount").value || "1", 10);
        const sender = document.getElementById("simSender").value || "live_viewer";

        await fetch("/api/gifts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                streamer_id: parseInt(streamerId, 10),
                gift_name: giftSel.value,
                diamond_count: diamonds,
                repeat_count: repeatCount,
                sender_username: sender,
                source: "manual",
            }),
        });
        loadOverview();
    });

    document.getElementById("btnSeedDemo").addEventListener("click", async () => {
        await fetch("/api/demo/seed", { method: "POST" });
        loadOverview();
    });

    document.getElementById("btnClearDemo").addEventListener("click", async () => {
        await fetch("/api/demo/clear", { method: "POST" });
        loadOverview();
    });

    document.getElementById("formSettings").addEventListener("submit", async (e) => {
        e.preventDefault();
        await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                usd_per_diamond: parseFloat(document.getElementById("setUsdPerDiamond").value),
                gross_usd_per_coin: parseFloat(document.getElementById("setGrossUsdPerCoin").value),
                usd_to_eur_rate: parseFloat(document.getElementById("setUsdToEur").value),
                poll_interval_seconds: parseInt(document.getElementById("setPollInterval").value, 10),
            }),
        });
        loadOverview();
    });

    // Battle Toolbar & Filter Listeners
    document.getElementById("battleStreamerSelect")?.addEventListener("change", (e) => {
        battleStreamerId = e.target.value;
        battleCurrentPage = 0;
        loadBattles();
        loadBattleStats();
    });

    document.getElementById("battleResultSelect")?.addEventListener("change", (e) => {
        battleResultFilter = e.target.value;
        battleCurrentPage = 0;
        loadBattles();
    });

    document.getElementById("battleModeSelect")?.addEventListener("change", (e) => {
        battleModeFilter = e.target.value;
        battleCurrentPage = 0;
        loadBattles();
    });

    document.getElementById("battlePeriodSelect")?.addEventListener("change", (e) => {
        battlePeriod = e.target.value;
        battleCurrentPage = 0;
        loadBattles();
        loadBattleStats();
    });

    let searchTimeout = null;
    document.getElementById("inputBattleSearch")?.addEventListener("input", (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            battleSearchTerm = e.target.value;
            battleCurrentPage = 0;
            loadBattles();
        }, 300);
    });

    document.getElementById("btnRefreshBattles")?.addEventListener("click", () => {
        loadBattles();
        loadBattleStats();
    });

    document.getElementById("btnBattlesPrev")?.addEventListener("click", () => {
        if (battleCurrentPage > 0) {
            battleCurrentPage--;
            loadBattles();
        }
    });

    document.getElementById("btnBattlesNext")?.addEventListener("click", () => {
        battleCurrentPage++;
        loadBattles();
    });

    // Battle Modal Listeners
    document.getElementById("btnCloseBattleModal")?.addEventListener("click", closeBattleGraphicModal);
    document.getElementById("btnCloseBattleModalBtn")?.addEventListener("click", closeBattleGraphicModal);
    document.getElementById("btnDownloadBattlePng")?.addEventListener("click", downloadBattleGraphicPng);
    document.getElementById("modalBattleGraphic")?.addEventListener("click", (e) => {
        if (e.target.id === "modalBattleGraphic") {
            closeBattleGraphicModal();
        }
    });

    // =========================================================================
    // SQLite Datenbank Importer Event Listeners
    // =========================================================================
    const btnInspect = document.getElementById("btnInspectSqlite");
    const btnRunImport = document.getElementById("btnRunSqliteImport");
    const inspectBox = document.getElementById("sqliteInspectBox");
    const inspectSummary = document.getElementById("sqliteInspectSummary");
    const inspectMeta = document.getElementById("sqliteInspectMeta");
    const inspectStreamers = document.getElementById("sqliteInspectStreamers");
    const resultBox = document.getElementById("sqliteImportResultBox");

    async function inspectSqliteDatabase() {
        const filePath = document.getElementById("inputSqlitePath")?.value?.trim() || "tiktok_earnings.db";
        if (btnInspect) btnInspect.disabled = true;
        if (resultBox) resultBox.style.display = "none";
        
        try {
            const res = await fetch(`/api/admin/sqlite/inspect?file_path=${encodeURIComponent(filePath)}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

            const info = data.data || {};
            if (inspectBox) inspectBox.style.display = "block";
            if (inspectMeta) inspectMeta.textContent = `${info.file_size_mb || 0} MB · ${info.total_records || 0} Datensätze gesamt`;

            if (inspectSummary) {
                const counts = info.table_counts || {};
                inspectSummary.innerHTML = `
                    <div style="background:var(--bg-card); padding:6px 8px; border-radius:6px; border:1px solid var(--border-subtle);">
                        <div class="muted mono" style="font-size:10px;">STREAMER</div>
                        <strong style="color:#38bdf8; font-size:15px;">${counts.streamers || 0}</strong>
                    </div>
                    <div style="background:var(--bg-card); padding:6px 8px; border-radius:6px; border:1px solid var(--border-subtle);">
                        <div class="muted mono" style="font-size:10px;">TIKTOK BATTLES</div>
                        <strong style="color:#f59e0b; font-size:15px;">${counts.tiktok_battles || 0}</strong>
                    </div>
                    <div style="background:var(--bg-card); padding:6px 8px; border-radius:6px; border:1px solid var(--border-subtle);">
                        <div class="muted mono" style="font-size:10px;">GIFT-EVENTS</div>
                        <strong style="color:#10b981; font-size:15px;">${counts.gift_events || 0}</strong>
                    </div>
                    <div style="background:var(--bg-card); padding:6px 8px; border-radius:6px; border:1px solid var(--border-subtle);">
                        <div class="muted mono" style="font-size:10px;">STREAM-SESSIONS</div>
                        <strong style="color:#a855f7; font-size:15px;">${counts.stream_sessions || 0}</strong>
                    </div>
                    <div style="background:var(--bg-card); padding:6px 8px; border-radius:6px; border:1px solid var(--border-subtle);">
                        <div class="muted mono" style="font-size:10px;">TELEGRAM USERS</div>
                        <strong style="font-size:15px;">${counts.telegram_users || 0}</strong>
                    </div>
                    <div style="background:var(--bg-card); padding:6px 8px; border-radius:6px; border:1px solid var(--border-subtle);">
                        <div class="muted mono" style="font-size:10px;">SETTINGS</div>
                        <strong style="font-size:15px;">${counts.settings || 0}</strong>
                    </div>
                `;
            }

            if (inspectStreamers) {
                const samples = info.streamer_samples || [];
                inspectStreamers.innerHTML = `<strong>Enthaltene Streamer:</strong> ${samples.length > 0 ? samples.map(s => `@${escapeHtml(s)}`).join(", ") : "Keine"}`;
            }
        } catch (err) {
            alert(`Analyse fehlgeschlagen: ${err.message}`);
        } finally {
            if (btnInspect) btnInspect.disabled = false;
        }
    }

    async function runSqliteImport() {
        const filePath = document.getElementById("inputSqlitePath")?.value?.trim() || "tiktok_earnings.db";
        const mode = document.getElementById("selectImportMode")?.value || "merge";

        // Ausgewählte Tabellen
        const checkedBoxes = Array.from(document.querySelectorAll(".cb-import-table:checked"));
        const selectedTables = checkedBoxes.map(cb => cb.value);

        if (selectedTables.length === 0) {
            alert("Bitte wähle mindestens eine Tabelle für den Import aus.");
            return;
        }

        const modeWarning = mode === "clean" 
            ? "ACHTUNG: Im Modus 'Ziel vorher leeren' werden die ausgewählten Tabellen vor dem Import vollständig geleert!\n\nMöchtest du wirklich fortfahren?"
            : `Daten aus '${filePath}' jetzt in die aktive Datenbank importieren/zusammenführen?`;

        if (!confirm(modeWarning)) {
            return;
        }

        if (btnRunImport) {
            btnRunImport.disabled = true;
            btnRunImport.textContent = "Importiert...";
        }

        try {
            const res = await fetch("/api/admin/sqlite/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    file_path: filePath,
                    tables: selectedTables,
                    mode: mode,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

            const r = data.result || {};
            if (resultBox) {
                resultBox.style.display = "block";
                resultBox.style.background = r.ok ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)";
                resultBox.style.border = `1px solid ${r.ok ? "#10b981" : "#ef4444"}`;
                resultBox.style.color = r.ok ? "#34d399" : "#ff7b72";

                const counts = r.imported_counts || {};
                const statsText = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" | ");
                
                resultBox.innerHTML = `
                    <div style="font-weight:700; margin-bottom:4px;">
                        ${r.ok ? "✅ Import erfolgreich abgeschlossen!" : "⚠️ Import mit Hinweisen/Fehlern beendet."}
                    </div>
                    <div class="mono" style="font-size:12px;">
                        Übertragene Datensätze (${r.total_imported}): ${statsText}
                    </div>
                    ${r.errors && r.errors.length > 0 ? `<div style="margin-top:6px; font-size:11px; color:#ff7b72;">Fehler: ${escapeHtml(r.errors.join(", "))}</div>` : ""}
                `;
            }

            // Dashboard neu laden
            loadOverview();
            loadBattles();
            loadBattleStats();
        } catch (err) {
            alert(`Import-Fehler: ${err.message}`);
        } finally {
            if (btnRunImport) {
                btnRunImport.disabled = false;
                btnRunImport.textContent = "Import starten";
            }
        }
    }

    btnInspect?.addEventListener("click", inspectSqliteDatabase);
    btnRunImport?.addEventListener("click", runSqliteImport);
    document.getElementById("btnRefreshHealth")?.addEventListener("click", () => {
        fetchSystemHealth(true);
    });
});

async function fetchSystemHealth(forceRefresh = false) {
    const btn = document.getElementById("btnRefreshHealth");
    if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ Lade...";
    }
    try {
        const url = `/api/system/health${forceRefresh ? "?force_refresh=true" : ""}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const health = await res.json();
        renderSystemHealth(health);
    } catch (e) {
        console.error("Fehler beim Abrufen der System-Health:", e);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "🔄 Aktualisieren";
        }
    }
}

function renderSystemHealth(health) {
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

    // 1. Host Disk
    const diskPct = typeof disk.percent === "number" ? disk.percent : 0;
    const elDiskPct = document.getElementById("gaugeDiskPercent");
    const elDiskBar = document.getElementById("gaugeDiskBar");
    const elDiskUsed = document.getElementById("gaugeDiskUsed");
    const elDiskFree = document.getElementById("gaugeDiskFree");
    const elDiskTotal = document.getElementById("gaugeDiskTotal");

    if (elDiskPct) elDiskPct.textContent = `${diskPct.toFixed(1)}%`;
    if (elDiskBar) {
        elDiskBar.style.width = `${Math.min(diskPct, 100)}%`;
        if (disk.status === "critical" || diskPct >= 85) {
            elDiskBar.style.background = "#ef4444";
        } else if (disk.status === "warning" || diskPct >= 75) {
            elDiskBar.style.background = "#f59e0b";
        } else {
            elDiskBar.style.background = "#10b981";
        }
    }
    if (elDiskUsed) elDiskUsed.textContent = `${disk.used_gb || 0} GB`;
    if (elDiskFree) elDiskFree.textContent = `${disk.free_gb || 0} GB`;
    if (elDiskTotal) elDiskTotal.textContent = `${disk.total_gb || 0} GB`;

    // 2. Host RAM
    const memPct = typeof mem.percent === "number" ? mem.percent : 0;
    const elRamPct = document.getElementById("gaugeRamPercent");
    const elRamBar = document.getElementById("gaugeRamBar");
    const elRamUsed = document.getElementById("gaugeRamUsed");
    const elRamFree = document.getElementById("gaugeRamFree");
    const elRamTotal = document.getElementById("gaugeRamTotal");

    if (elRamPct) elRamPct.textContent = `${memPct.toFixed(1)}%`;
    if (elRamBar) {
        elRamBar.style.width = `${Math.min(memPct, 100)}%`;
        if (memPct >= 90) elRamBar.style.background = "#ef4444";
        else if (memPct >= 75) elRamBar.style.background = "#f59e0b";
        else elRamBar.style.background = "#3b82f6";
    }
    if (elRamUsed) elRamUsed.textContent = fmtMbOrGb(mem.used_mb);
    if (elRamFree) elRamFree.textContent = fmtMbOrGb(mem.free_mb);
    if (elRamTotal) elRamTotal.textContent = fmtMbOrGb(mem.total_mb);

    // 3. Host CPU & Load
    const cpuPct = typeof cpu.percent === "number" ? cpu.percent : 0;
    const elCpuPct = document.getElementById("gaugeCpuPercent");
    const elCpuBar = document.getElementById("gaugeCpuBar");
    const elCpuLoad = document.getElementById("gaugeCpuLoad");
    const elCpuCores = document.getElementById("gaugeCpuCores");

    if (elCpuPct) elCpuPct.textContent = `${cpuPct.toFixed(1)}%`;
    if (elCpuBar) {
        elCpuBar.style.width = `${Math.min(cpuPct, 100)}%`;
        if (cpuPct >= 85) elCpuBar.style.background = "#ef4444";
        else if (cpuPct >= 65) elCpuBar.style.background = "#f59e0b";
        else elCpuBar.style.background = "#8b5cf6";
    }
    if (elCpuLoad) {
        const l1 = typeof cpu.load_1m === "number" ? cpu.load_1m.toFixed(2) : "-";
        const l5 = typeof cpu.load_5m === "number" ? cpu.load_5m.toFixed(2) : "-";
        const l15 = typeof cpu.load_15m === "number" ? cpu.load_15m.toFixed(2) : "-";
        elCpuLoad.textContent = `${l1} / ${l5} / ${l15}`;
    }
    if (elCpuCores) elCpuCores.textContent = `${cpu.cpu_count || 1} Kerne`;

    // 4. Header Badge & Timestamp
    const elBadge = document.getElementById("healthDockerBadge");
    const elUpdated = document.getElementById("healthLastUpdated");
    const elCount = document.getElementById("cntContainerCount");

    if (elBadge) {
        if (docker.available) {
            const runningCount = (docker.containers || []).filter(c => c.state === "running").length;
            elBadge.textContent = `Docker: Verbunden (${runningCount}/${(docker.containers || []).length} aktiv)`;
            elBadge.className = "status-tag live";
        } else {
            elBadge.textContent = "Docker: Nicht verbunden (Host-Only)";
            elBadge.className = "status-tag polling";
        }
    }
    if (elUpdated) {
        const d = health.timestamp ? new Date(health.timestamp * 1000) : new Date();
        elUpdated.textContent = d.toLocaleTimeString("de-DE");
    }
    if (elCount) {
        elCount.textContent = `(${ (docker.containers || []).length } Container)`;
    }

    // 5. Container Table
    const elTbody = document.getElementById("tblContainersBody");
    if (elTbody) {
        const containers = docker.containers || [];
        if (!docker.available) {
            elTbody.innerHTML = `<tr><td colspan="7" class="muted">Docker Socket (/var/run/docker.sock) ist nicht gemountet oder nicht erreichbar (${escapeHtml(docker.error || 'Host-Fallback aktiv')}).</td></tr>`;
        } else if (containers.length === 0) {
            elTbody.innerHTML = `<tr><td colspan="7" class="muted">Keine überwachten TokTracker-Container gefunden.</td></tr>`;
        } else {
            elTbody.innerHTML = containers.map(c => {
                const isRunning = c.state === "running";
                const stateTag = `<span class="status-tag ${isRunning ? 'live' : 'danger'}" style="font-size: 10px;">${escapeHtml(c.status || c.state)}</span>`;
                const memUsedMb = c.memory ? c.memory.used_mb : 0;
                const memLimitMb = c.memory ? c.memory.limit_mb : 0;
                const memPct = c.memory ? c.memory.percent : 0;
                const memText = `${memUsedMb} MB / ${fmtMbOrGb(memLimitMb)}`;
                const memBar = `
                    <div style="display: flex; align-items: center; gap: 6px; width: 110px;">
                        <div style="flex: 1; height: 6px; background: var(--bg-subtle); border-radius: 3px; overflow: hidden;">
                            <div style="width: ${Math.min(memPct, 100)}%; height: 100%; background: #3b82f6;"></div>
                        </div>
                        <span class="mono muted" style="font-size: 10px; width: 32px; text-align: right;">${memPct.toFixed(0)}%</span>
                    </div>`;
                const cpuVal = typeof c.cpu_percent === "number" ? `${c.cpu_percent.toFixed(1)}%` : "--";
                const rwSize = c.size_rw_mb !== undefined && c.size_rw_mb !== null ? `${c.size_rw_mb} MB` : "--";
                const rootFs = c.size_root_fs_mb ? `<span class="muted" style="font-size: 10px;"> (${c.size_root_fs_mb} MB)</span>` : "";

                return `
                    <tr>
                        <td style="font-weight: 600;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: ${isRunning ? '#10b981' : '#ef4444'};"></span>
                                <span>${escapeHtml(c.name)}</span>
                            </div>
                        </td>
                        <td>${stateTag}</td>
                        <td class="mono">${cpuVal}</td>
                        <td class="mono">${memText}</td>
                        <td>${memBar}</td>
                        <td class="mono" style="font-weight: 600; color: #38bdf8;">${rwSize}${rootFs}</td>
                        <td class="mono muted" style="font-size: 10px;">
                            <span>${escapeHtml(c.id || '')}</span>
                            <div style="font-size: 9.5px; opacity: 0.8;">${escapeHtml(c.image || '')}</div>
                        </td>
                    </tr>
                `;
            }).join("");
        }
    }

    // 6. Docker Volumes
    const elVols = document.getElementById("listVolumesContainer");
    if (elVols) {
        const vols = docker.volumes || [];
        if (vols.length === 0) {
            elVols.innerHTML = `<span class="muted">Keine Docker-Volumes ermittelt.</span>`;
        } else {
            elVols.innerHTML = vols.map(v => {
                const sz = v.size_mb > 0 ? `${v.size_mb} MB` : (v.usage_data && v.usage_data.Size ? `${(v.usage_data.Size / 1024 / 1024).toFixed(1)} MB` : 'Aktiv');
                return `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px dashed var(--border-subtle);">
                        <span>📁 <strong>${escapeHtml(v.name)}</strong> <span class="muted" style="font-size: 9.5px;">(${escapeHtml(v.driver || 'local')})</span></span>
                        <span class="mono" style="font-weight: 600; color: #34d399;">${sz}</span>
                    </div>
                `;
            }).join("");
        }
    }

    // 7. Database storage & tables
    const elDbBadge = document.getElementById("dbTotalSizeBadge");
    const elDbList = document.getElementById("listDbTablesContainer");
    if (elDbBadge) {
        const dbEngine = (db.engine || 'MySQL').toUpperCase();
        elDbBadge.textContent = `${db.total_mb || 0} MB (${dbEngine})`;
    }
    if (elDbList) {
        const tables = db.tables || [];
        if (tables.length === 0) {
            elDbList.innerHTML = `<span class="muted">Keine Tabellendaten verfügbar.</span>`;
        } else {
            elDbList.innerHTML = tables.slice(0, 6).map(t => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px dashed var(--border-subtle);">
                    <span>📊 <strong>${escapeHtml(t.table)}</strong> <span class="muted" style="font-size: 10px;">(${fmtNum(t.rows || 0)} Zeilen)</span></span>
                    <span class="mono" style="color: #60a5fa;">${t.size_mb} MB</span>
                </div>
            `).join("");
        }
    }
}
