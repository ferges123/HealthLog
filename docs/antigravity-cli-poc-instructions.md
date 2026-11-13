# Antigravity CLI PoC — Instrukcja uruchomienia

## Szybki start

```bash
cd /home/ferges/Projects/HealthLog
pnpm tsx scripts/antigravity-acp-poc.ts
```

## Wymagania

1. `agy` CLI zainstalowane i uwierzytelnione (wersja 1.5.8)
2. Dostęp do konta Antigravity (opcja Enterprise lub osobista)
3. ~5 minut czasu

## Co testuje PoC

| Test | Opis |
|------|------|
| Initialize | Negocjacja protokołu, capability discovery |
| Session/new | Tworzenie sesji, config options, modele |
| Simple completion | Podstawowy text completion |
| Streaming | Streaming chunks |
| Multi-turn | Pamięć między turami |
| Image | Czy obrazy są rzeczywiście przetwarzane |
| PDF | Czy PDF blob jest analizowany |
| Cancellation | Anulowanie podczas generowania |
| Profile isolation | Dwa izolowane profile równolegle |

## Dane testowe

- **Obraz**: 1x1 pixel PNG (syntetyczny, nie medyczny)
- **PDF**: Jednostronicowy z tekstem "I am page 1 of 1"
- **Prompty**: "2+2", "count 1-10", "remember my name"

## Bezpieczeństwo

PoC:
- ✅ Używa `--sandbox`
- ✅ Używa `--disable-telemetry`
- ✅ Pusty workspace (`/tmp/healthlog-acp-workspace-*`)
- ✅ `mcpServers: []`
- ✅ Odrzuca wszystkie permission requests
- ❌ NIE używa `--dangerously-skip-permissions`
- ❌ NIE używa `--add-dir`
- ❌ NIE loguje surowego stderr

## Wynik

Po uruchomieniu otrzymasz:

1. Lista passed/failed testów
2. Informację o capabilities (image, PDF, audio)
3. Dostępne modele z `configOptions`
4. Profil isolation status

**Zapisz wynik** do `docs/antigravity-cli-transport-decision.md`.
