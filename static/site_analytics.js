/**
 * site_analytics.js
 * -----------------
 * Dashboard-Controller für Website-Traffic, Besucher-Audits und Bot-Sessions.
 */

(function () {
    "use strict";

    let currentPeriod = "today";
    let autoRefreshTimer = null;
    let trafficChartInstance = null;
    let pathsChartInstance = null;

    // Hilfsfunktionen
    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatNumber(num) {
        return new Intl.NumberFormat("de-DE").format(num || 0);
    }

    function formatTime(dtStr) {
        if (!dtStr) return "-";
        const parts = dtStr.split(" ");
        if (parts.length > 1) {
            return parts[1];
        }
        return dtStr;
    }

    function getDeviceIcon(device) {
        const d = (device || "").toLowerCase();
        if (d === "mobile") return "📱 Mobile";
        if (d === "tablet") return "📟 Tablet";
        if (d === "bot") return "🤖 Bot / Crawler";
        return "💻 Desktop";
    }

    function getStatusBadge(code) {
        const c = parseInt(code, 10) || 200;
        if (c >= 200 && c < 300) {
            return `<span class="status-badge-ok">${c} OK</span>`;
        }
        if (c >= 300 && c < 400) {
            return `<span class="status-badge-redirect">${c} REDIR</span>`;
        }
        return `<span class="status-badge-err">${c} ERR</span>`;
    }

    // Daten vom Server laden
    async function loadAnalyticsData() {
        const spinner = document.getElementById("refreshSpinner");
        if (spinner) spinner.style.transform = "rotate(180deg)";

        try {
            const resp = await fetch(`/api/site-analytics?period=${currentPeriod}`, {
                headers: { "Accept": "application/json" },
            });
            if (!resp.ok) {
                if (resp.status === 401 || resp.status === 403) {
                    window.location.href = "/login";
                    return;
                }
                throw new Error(`HTTP ${resp.status}`);
            }
            const data = await resp.json();
            renderDashboard(data);
        } catch (err) {
            console.error("Fehler beim Laden der Analytik-Daten:", err);
        } finally {
            if (spinner) {
                setTimeout(() => {
                    spinner.style.transform = "rotate(0deg)";
                }, 300);
            }
        }
    }

    // Dashboard rendern
    function renderDashboard(data) {
        const kpis = data.kpis || {};
        const totalViews = kpis.total_views || 0;
        const uniqueVisitors = kpis.unique_visitors || 0;
        const avgLatency = kpis.avg_latency || 0;
        const mobileViews = kpis.mobile_views || 0;
        const desktopViews = kpis.desktop_views || 0;

        // KPI-Werte setzen
        const elViews = document.getElementById("kpiTotalViews");
        if (elViews) elViews.textContent = formatNumber(totalViews);

        const elVisitors = document.getElementById("kpiUniqueVisitors");
        if (elVisitors) elVisitors.textContent = formatNumber(uniqueVisitors);

        const elLatency = document.getElementById("kpiAvgLatency");
        if (elLatency) elLatency.textContent = `${avgLatency} ms`;

        const totalDevices = mobileViews + desktopViews;
        const desktopPct = totalDevices > 0 ? Math.round((desktopViews / totalDevices) * 100) : 0;
        const mobilePct = totalDevices > 0 ? Math.round((mobileViews / totalDevices) * 100) : 0;
        const elSplit = document.getElementById("kpiDeviceSplit");
        if (elSplit) elSplit.textContent = `${desktopPct}% / ${mobilePct}%`;

        const botSessions = data.bot_sessions || [];
        const elBotSessions = document.getElementById("kpiBotSessions");
        if (elBotSessions) elBotSessions.textContent = formatNumber(botSessions.length);

        const workers = data.tiktok_workers || [];
        const activeWorkers = workers.filter(w => w.is_live || w.is_monitoring || w.status === "monitoring" || w.status === "connected").length;
        const elWorkers = document.getElementById("kpiActiveWorkers");
        if (elWorkers) elWorkers.textContent = `${activeWorkers} von ${workers.length}`;

        // Charts rendern
        renderTrafficChart(data.timeline || []);
        renderPathsChart(data.paths || []);

        // Tabellen rendern
        renderPathsTable(data.paths || [], totalViews);
        renderRecentViewsTable(data.recent_views || []);
        renderBotSessionsTable(botSessions);
        renderChallengesTable(data.recent_challenges || []);
        renderWorkersTable(workers);
        renderUsersTable(data.telegram_users || []);
    }

    // Chart: Traffic Timeline
    function renderTrafficChart(timeline) {
        const canvas = document.getElementById("chartTrafficTimeline");
        if (!canvas) return;
        if (typeof Chart === "undefined") {
            console.warn("Chart.js ist nicht geladen");
            return;
        }

        const hasData = timeline && timeline.length > 0;
        const labels = hasData ? timeline.map(t => t.label || t.bucket) : ["Keine Daten"];
        const viewsData = hasData ? timeline.map(t => t.views || 0) : [0];
        const visitorsData = hasData ? timeline.map(t => t.visitors || 0) : [0];

        if (trafficChartInstance) {
            trafficChartInstance.data.labels = labels;
            trafficChartInstance.data.datasets[0].data = viewsData;
            trafficChartInstance.data.datasets[1].data = visitorsData;
            trafficChartInstance.update();
            return;
        }

        const ctx = canvas.getContext("2d");
        trafficChartInstance = new Chart(ctx, {
            type: "line",
            data: {
                labels: labels,
                datasets: [
                    {
                        label: "Aufrufe (Views)",
                        data: viewsData,
                        borderColor: "#38bdf8",
                        backgroundColor: "rgba(56, 189, 248, 0.12)",
                        borderWidth: 2,
                        tension: 0.35,
                        fill: true,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                    },
                    {
                        label: "Unique Visitors",
                        data: visitorsData,
                        borderColor: "#10b981",
                        backgroundColor: "rgba(16, 185, 129, 0.12)",
                        borderWidth: 2,
                        tension: 0.35,
                        fill: true,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: "index",
                },
                plugins: {
                    legend: {
                        position: "top",
                        labels: {
                            color: "#94a3b8",
                            font: { family: "inherit", size: 11, weight: "bold" },
                        },
                    },
                    tooltip: {
                        backgroundColor: "rgba(18, 23, 31, 0.95)",
                        titleColor: "#f0f6fc",
                        bodyColor: "#e6edf3",
                        borderColor: "#30363d",
                        borderWidth: 1,
                        padding: 10,
                    },
                },
                scales: {
                    x: {
                        grid: { color: "rgba(255, 255, 255, 0.05)" },
                        ticks: { color: "#64748b", font: { size: 10.5 } },
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: "rgba(255, 255, 255, 0.05)" },
                        ticks: {
                            color: "#64748b",
                            font: { size: 10.5 },
                            precision: 0,
                        },
                    },
                },
            },
        });
    }

    // Chart: Paths Doughnut
    function renderPathsChart(paths) {
        const canvas = document.getElementById("chartPathsBreakdown");
        if (!canvas) return;
        if (typeof Chart === "undefined") {
            console.warn("Chart.js ist nicht geladen");
            return;
        }

        const hasPaths = paths && paths.length > 0;
        let labels = [];
        let dataVals = [];
        let colors = [];

        if (hasPaths) {
            const topPaths = paths.slice(0, 5);
            const otherCount = paths.slice(5).reduce((acc, p) => acc + (p.views || 0), 0);

            labels = topPaths.map(p => p.path);
            dataVals = topPaths.map(p => p.views);
            if (otherCount > 0) {
                labels.push("Andere");
                dataVals.push(otherCount);
            }

            colors = [
                "#38bdf8",
                "#8b5cf6",
                "#ec4899",
                "#10b981",
                "#f59e0b",
                "#64748b",
            ].slice(0, labels.length);
        } else {
            labels = ["Keine Aufrufe"];
            dataVals = [1];
            colors = ["rgba(255, 255, 255, 0.08)"];
        }

        if (pathsChartInstance) {
            pathsChartInstance.data.labels = labels;
            pathsChartInstance.data.datasets[0].data = dataVals;
            pathsChartInstance.data.datasets[0].backgroundColor = colors;
            pathsChartInstance.update();
            return;
        }

        const ctx = canvas.getContext("2d");
        pathsChartInstance = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels: labels,
                datasets: [
                    {
                        data: dataVals,
                        backgroundColor: colors,
                        borderColor: "#12171f",
                        borderWidth: 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: "bottom",
                        labels: {
                            color: "#94a3b8",
                            font: { family: "inherit", size: 10.5 },
                            boxWidth: 12,
                        },
                    },
                },
            },
        });
    }

    // Tabelle 1: Top Paths
    function renderPathsTable(paths, totalViews) {
        const tbody = document.getElementById("tbodyPaths");
        const badge = document.getElementById("badgePathsCount");
        if (badge) badge.textContent = `${paths.length} Pfade`;
        if (!tbody) return;

        if (paths.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--text-muted);">Noch keine Seitenaufrufe im ausgewählten Zeitraum.</td></tr>`;
            return;
        }

        tbody.innerHTML = paths.map(p => {
            const v = p.views || 0;
            const pct = totalViews > 0 ? Math.round((v / totalViews) * 100) : 0;
            return `
                <tr>
                    <td style="font-weight: 700; color: #38bdf8;">${escapeHtml(p.path)}</td>
                    <td style="font-family: var(--font-mono); font-weight: 700;">${formatNumber(v)}</td>
                    <td class="hide-sm" style="font-family: var(--font-mono); color: #10b981;">${formatNumber(p.visitors || 0)}</td>
                    <td class="hide-sm" style="font-family: var(--font-mono); color: var(--text-muted);">${p.avg_ms || 0} ms</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div style="flex: 1; height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;">
                                <div style="width: ${pct}%; height: 100%; background: #38bdf8; border-radius: 3px;"></div>
                            </div>
                            <span style="font-size: 11px; font-family: var(--font-mono); min-width: 32px;">${pct}%</span>
                        </div>
                    </td>
                </tr>
            `;
        }).join("");
    }

    // Tabelle 2: Recent Views
    function renderRecentViewsTable(views) {
        const tbody = document.getElementById("tbodyRecentViews");
        if (!tbody) return;

        if (views.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--text-muted);">Keine aktuellen Zugriffe erfasst.</td></tr>`;
            return;
        }

        tbody.innerHTML = views.map(v => {
            return `
                <tr>
                    <td style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted);">${escapeHtml(v.created_at || "")}</td>
                    <td style="font-weight: 700;">${escapeHtml(v.path || "")}</td>
                    <td class="hide-sm">${getDeviceIcon(v.device_type)}</td>
                    <td>${getStatusBadge(v.status_code)}</td>
                    <td class="hide-sm" style="font-family: var(--font-mono);">${v.response_time_ms || 0} ms</td>
                    <td class="hide-md"><span class="ip-hash-badge">${escapeHtml((v.visitor_hash || "").substring(0, 12))}…</span></td>
                    <td class="hide-sm" style="font-size: 11px; color: var(--text-muted); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(v.referrer || "-")}</td>
                </tr>
            `;
        }).join("");
    }

    // Tabelle 3: Bot Sessions
    function renderBotSessionsTable(sessions) {
        const tbody = document.getElementById("tbodyBotSessions");
        const badge = document.getElementById("badgeBotSessionsCount");
        if (badge) badge.textContent = `${sessions.length} Sessions`;
        if (!tbody) return;

        if (sessions.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--text-muted);">Keine Bot- oder Mini-App Sessions vorhanden.</td></tr>`;
            return;
        }

        tbody.innerHTML = sessions.map(s => {
            const isMiniApp = s.session_type === "miniapp";
            const typeLabel = isMiniApp ? "📱 Telegram Mini-App" : "🔑 2FA Login-Challenge";
            const userLabel = s.username ? `@${escapeHtml(s.username)}` : (s.first_name ? escapeHtml(s.first_name) : `ID: ${s.telegram_id || "-"}`);
            const statusClass = s.status === "admin" ? "status-badge-ok" : (s.status === "approved" ? "status-badge-ok" : "status-badge-redirect");

            return `
                <tr>
                    <td style="font-weight: 700;">${typeLabel}</td>
                    <td><strong style="color: #38bdf8;">${userLabel}</strong> ${s.telegram_id ? `<span style="font-size:10.5px; color:var(--text-muted);">(${s.telegram_id})</span>` : ""}</td>
                    <td><span class="${statusClass}">${escapeHtml((s.status || "active").toUpperCase())}</span></td>
                    <td class="hide-sm"><span class="ip-hash-badge">${escapeHtml((s.client_ip_hash || "").substring(0, 10))}…</span></td>
                    <td class="hide-md" style="font-size: 11.5px; color: var(--text-muted);">${escapeHtml(s.created_at || "-")}</td>
                    <td class="hide-sm" style="font-size: 11.5px; color: var(--text-muted);">${escapeHtml(s.last_active_at || "-")}</td>
                </tr>
            `;
        }).join("");
    }

    // Tabelle: 2FA Challenges
    function renderChallengesTable(challenges) {
        const tbody = document.getElementById("tbodyChallenges");
        if (!tbody) return;

        if (challenges.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--text-muted);">Keine offenen 2FA-Challenges vorhanden.</td></tr>`;
            return;
        }

        tbody.innerHTML = challenges.map(c => {
            const st = (c.status || "pending").toLowerCase();
            const badgeClass = st === "approved" || st === "consumed" ? "status-badge-ok" : (st === "rejected" ? "status-badge-err" : "status-badge-redirect");
            const relTime = formatTime(new Date((c.created_at || 0) * 1000).toLocaleTimeString("de-DE"));

            return `
                <tr>
                    <td class="hide-sm" style="font-family: var(--font-mono); font-size: 11px;">${escapeHtml(c.id || "")}</td>
                    <td style="font-family: var(--font-mono); font-weight: 800; font-size: 14px; letter-spacing: 2px; color: #f59e0b;">${escapeHtml(c.code || "******")}</td>
                    <td><span class="${badgeClass}">${st.toUpperCase()}</span></td>
                    <td class="hide-sm" style="font-size: 11.5px; color: var(--text-muted);">${escapeHtml(c.client_info || "-")}</td>
                    <td style="color: #10b981; font-weight: 700;">${escapeHtml(c.admin_label || "-")}</td>
                    <td class="hide-sm" style="font-size: 11.5px; color: var(--text-muted);">${relTime}</td>
                </tr>
            `;
        }).join("");
    }

    // Tabelle 4: TikTok Live Workers
    function renderWorkersTable(workers) {
        const tbody = document.getElementById("tbodyWorkers");
        const badge = document.getElementById("badgeWorkerCount");
        if (badge) badge.textContent = `${workers.length} Worker`;
        if (!tbody) return;

        if (workers.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--text-muted);">Keine aktiven TikTok-Worker registriert.</td></tr>`;
            return;
        }

        tbody.innerHTML = workers.map(w => {
            const isLive = Boolean(w.is_live);
            const statusLabel = isLive ? "🔴 LIVE" : (w.is_monitoring ? "🟡 MONITORING" : "⚪ OFFLINE");
            const statusClass = isLive ? "status-badge-err" : (w.is_monitoring ? "status-badge-redirect" : "status-badge-ok");

            return `
                <tr>
                    <td style="display: flex; align-items: center; gap: 8px;">
                        <img src="${escapeHtml(w.avatar_url || '/static/avatar_default.png')}" style="width: 26px; height: 26px; border-radius: 50%; object-fit: cover;" onerror="this.src='/static/avatar_default.png'">
                        <div>
                            <div style="font-weight: 700;">${escapeHtml(w.display_name || w.username || "")}</div>
                            <div style="font-size: 10.5px; color: var(--text-muted);">@${escapeHtml(w.username || "")}</div>
                        </div>
                    </td>
                    <td><span class="${statusClass}">${statusLabel}</span></td>
                    <td class="hide-sm" style="font-family: var(--font-mono); font-size: 11px;">${escapeHtml(w.last_seen_live || "Nie")}</td>
                    <td style="font-family: var(--font-mono); font-weight: 700; color: #38bdf8;">${formatNumber(w.total_diamonds || 0)}</td>
                    <td class="hide-sm" style="font-family: var(--font-mono);">${w.reconnect_count || 0}</td>
                    <td class="hide-md" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(w.last_error || "Bereit")}</td>
                </tr>
            `;
        }).join("");
    }

    // Tabelle 5: Telegram Users
    function renderUsersTable(users) {
        const tbody = document.getElementById("tbodyUsers");
        const badge = document.getElementById("badgeUsersCount");
        if (badge) badge.textContent = `${users.length} Nutzer`;
        if (!tbody) return;

        if (users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--text-muted);">Keine Telegram-Nutzer registriert.</td></tr>`;
            return;
        }

        tbody.innerHTML = users.map(u => {
            const isAllowed = u.is_allowed === 1;
            const isBlocked = u.is_allowed === -1;
            const allowBadge = isAllowed
                ? `<span class="status-badge-ok">ERLAUBT</span>`
                : (isBlocked ? `<span class="status-badge-err">GESPERRT</span>` : `<span class="status-badge-redirect">WARTEND</span>`);
            const roleBadge = u.role === "admin"
                ? `<span style="background: rgba(139, 92, 246, 0.2); color: #c084fc; border: 1px solid #8b5cf6; padding: 2px 6px; border-radius: 3px; font-size: 10.5px; font-weight: 700;">ADMIN</span>`
                : `<span style="background: rgba(255, 255, 255, 0.05); color: #94a3b8; border: 1px solid rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 3px; font-size: 10.5px;">USER</span>`;

            return `
                <tr>
                    <td class="hide-sm" style="font-family: var(--font-mono); font-size: 11.5px;">${escapeHtml(String(u.telegram_id || u.id || ""))}</td>
                    <td style="font-weight: 700; color: #38bdf8;">@${escapeHtml(u.username || "anonym")}</td>
                    <td class="hide-sm">${escapeHtml(u.first_name || "-")}</td>
                    <td>${roleBadge}</td>
                    <td>${allowBadge}</td>
                    <td class="hide-md" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(u.last_seen_at || "-")}</td>
                    <td class="hide-sm" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(u.created_at || "-")}</td>
                </tr>
            `;
        }).join("");
    }

    // Globaler Tab-Wechsler
    window.switchSection = function (sectionId) {
        document.querySelectorAll(".analytics-section").forEach(s => s.style.display = "none");
        const sec = document.getElementById(sectionId);
        if (sec) sec.style.display = "block";

        const btnMap = {
            "sectionPaths": "tabBtnPaths",
            "sectionLog": "tabBtnLog",
            "sectionBotSessions": "tabBtnBotSessions",
            "sectionWorkers": "tabBtnWorkers",
            "sectionUsers": "tabBtnUsers",
        };

        Object.values(btnMap).forEach(bId => {
            const b = document.getElementById(bId);
            if (b) b.classList.remove("active");
        });

        const activeBtn = document.getElementById(btnMap[sectionId]);
        if (activeBtn) activeBtn.classList.add("active");
    };

    // Initialisierung & Event Listener
    document.addEventListener("DOMContentLoaded", () => {
        // Tab Navigation Listeners
        const tabMappings = {
            "tabBtnPaths": "sectionPaths",
            "tabBtnLog": "sectionLog",
            "tabBtnBotSessions": "sectionBotSessions",
            "tabBtnWorkers": "sectionWorkers",
            "tabBtnUsers": "sectionUsers",
        };
        Object.entries(tabMappings).forEach(([btnId, secId]) => {
            const btn = document.getElementById(btnId);
            if (btn) {
                btn.addEventListener("click", () => window.switchSection(secId));
            }
        });

        // Period Buttons
        document.querySelectorAll("[data-period]").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll("[data-period]").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                currentPeriod = btn.getAttribute("data-period") || "today";
                loadAnalyticsData();
            });
        });

        // Manual Refresh Button
        const btnRefresh = document.getElementById("btnManualRefresh");
        if (btnRefresh) {
            btnRefresh.addEventListener("click", () => {
                loadAnalyticsData();
            });
        }

        // Auto Refresh Checkbox
        const chkAuto = document.getElementById("chkAutoRefresh");
        function updateAutoRefresh() {
            if (autoRefreshTimer) {
                clearInterval(autoRefreshTimer);
                autoRefreshTimer = null;
            }
            if (chkAuto && chkAuto.checked) {
                autoRefreshTimer = setInterval(() => {
                    loadAnalyticsData();
                }, 30000);
            }
        }
        if (chkAuto) {
            chkAuto.addEventListener("change", updateAutoRefresh);
            updateAutoRefresh();
        }

        // Erster Aufruf
        loadAnalyticsData();
    });
})();
