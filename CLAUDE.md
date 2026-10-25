## Roadmap und Issues

- Roadmap, Spezifikationen und Entscheidungen liegen im `ferrion`-Repo (nicht öffentlich) unter `docs/roadmap/`; welche Schritte dieses Repo betreffen, steht in `docs/roadmap.md`.
- Bugs, Verbesserungen und Handgriffe sind GitHub Issues im Repo `hendrikpriemer/ferrion` mit Label `bereich:gateway`, nicht in diesem Repo. Ablauf, Stufen (P1 sofort, auch außerhalb der Fokusregel; P2 mit dem nächsten Update; P3 gebündelt) und Labels stehen dort in `docs/process/feedback-workflow.md`.
- PRs hier verweisen auf das Issue mit vollem Namen: `Fixes hendrikpriemer/ferrion#123`, bzw. `Refs …`, wenn die Bestätigung auf der VM aussteht (Label `vm-prüfen`).
- Befunde aus dem Betrieb mit `gh issue create --repo hendrikpriemer/ferrion --label bug --label bereich:gateway` erfassen (Gliederung: Beobachtet, Erwartet, Belege, Schwere, Vermutung).
- Commits und PR-Titel tragen die Roadmap-ID, z. B. `feat(R07): DISCOVER_DEVICES im Befehlskanal`.
- Vor neuer Arbeit `git fetch` und `git log HEAD..origin/main` prüfen; das Repo wird von mehreren Rechnern aus gepusht.
