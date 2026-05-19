# Alltagshelfer Todo Card

Elegante Custom Lovelace Card für Home Assistant mit Fälligkeitsterminen, Wiederholungen und Push-Erinnerungen via HA Companion App.

---

## Features

- Aufgaben hinzufügen, abhaken, bearbeiten, löschen
- Fälligkeitsdaten mit farbigen Badges (Heute / Morgen / Überfällig)
- Wiederkehrende Aufgaben (täglich, wöchentlich, monatlich, jährlich, Werktags)
- Push-Erinnerungen via Home Assistant Companion App (Automation nötig)
- Erledigte Aufgaben ein-/ausblenden
- Passt sich automatisch jedem HA Theme an (Dark / Light / Liquid Glass)
- Kein Build-Step, kein Framework – reines Vanilla JS

---

## Installation via HACS

1. HACS öffnen → **Frontend** → Drei-Punkte-Menü rechts oben → **Custom repositories**
2. Eintragen:
   - **URL**: `https://github.com/f-hohengarten/alltagshelfer-todo-card`
   - **Kategorie**: Lovelace
3. → **Add** → Repo in der Liste suchen → **Download**
4. Home Assistant Browser-Seite neu laden (Strg+F5 / Cmd+Shift+R)

---

## Einrichtung

### Schritt 1 – Todo-Entity in HA anlegen

**Einstellungen → Hilfsprogramme → Hinzufügen → Aufgabenliste**

| Feld | Wert |
|---|---|
| Name | Aufgaben |
| Entity-ID (automatisch) | `todo.aufgaben` |

### Schritt 2 – Card ins Dashboard einfügen

Im Lovelace Raw Config Editor oder Dashboard-YAML:

```yaml
type: custom:alh-todo-card
entity: todo.aufgaben
```

**Alle Optionen:**

| Option | Typ | Standard | Beschreibung |
|---|---|---|---|
| `entity` | string | – | todo.* Entity (Pflichtfeld) |
| `title` | string | `Aufgaben` | Titel der Card |
| `show_completed` | boolean | `false` | Erledigte beim Start anzeigen |

---

## Lokale Installation (ohne HACS)

1. `alh-todo-card.js` nach `config/www/alh-todo-card.js` kopieren
2. **Einstellungen → Dashboards → Ressourcen → Hinzufügen**
   - URL: `/local/alh-todo-card.js`
   - Typ: JavaScript-Modul
3. Browser neu laden

---

## Wiederkehrende Aufgaben

Beim Anlegen oder Bearbeiten einer Aufgabe auf **↩ Wiederholen** klicken und Intervall wählen:

- Täglich
- Wöchentlich
- Monatlich
- Jährlich
- Werktags (Mo–Fr)

Wenn eine wiederkehrende Aufgabe abgehakt wird, erstellt die Card **automatisch** den nächsten Eintrag mit dem berechneten Fälligkeitsdatum.

---

## Push-Erinnerungen

Die Card speichert die Erinnerungspräferenz in der Aufgaben-Beschreibung. Eine HA Automation sendet die Benachrichtigung zur richtigen Zeit.

### Schritt 1 – Gerätename herausfinden

In HA: **Einstellungen → Mobil-Apps** → Dein iPhone → Entity-ID notieren  
Beispiel: `notify.mobile_app_iphone_von_max`

### Schritt 2 – Automation erstellen

**Einstellungen → Automatisierungen → Neu → YAML-Modus** – folgenden Code einfügen:

```yaml
alias: "Todo-Erinnerungen senden"
description: "Sendet Push-Benachrichtigungen für fällige Aufgaben via HA Companion App"
trigger:
  - platform: time
    at: "09:00:00"
action:
  - variables:
      heute:  "{{ now().strftime('%Y-%m-%d') }}"
      morgen: "{{ (now() + timedelta(days=1)).strftime('%Y-%m-%d') }}"
      items:  "{{ state_attr('todo.aufgaben', 'items') | selectattr('status', 'eq', 'needs_action') | list }}"
  - repeat:
      for_each: "{{ items }}"
      sequence:
        - variables:
            desc: "{{ repeat.item.description | default('') }}"
            due:  "{{ repeat.item.due | default('') }}"
            remind_today: "{{ 'remind:0' in desc and due == heute }}"
            remind_1day:  "{{ 'remind:1' in desc and due == morgen }}"
        - choose:
            - conditions: "{{ remind_today or remind_1day }}"
              sequence:
                - service: notify.mobile_app_DEIN_GERAET   # ← anpassen!
                  data:
                    title: "📋 Aufgabe fällig"
                    message: >
                      {{ repeat.item.summary }}
                      {{ '(morgen)' if remind_1day else '' }}
                    data:
                      url: /lovelace/todos
mode: single
```

> `notify.mobile_app_DEIN_GERAET` mit deiner echten Entity-ID ersetzen.

---

## iOS Reminders → Home Assistant synchronisieren

Da Apple keine öffentliche Reminders-API bietet, fungiert **Apple Kurzbefehle** als Brücke.

### Voraussetzungen

- HA ist extern erreichbar
- Long-Lived Access Token erstellen:  
  **HA → Profil (unten links) → Sicherheit → Long-Lived Access Tokens → Token erstellen**  
  Wert kopieren und sicher aufbewahren.

### Kurzbefehl erstellen

Neuen Kurzbefehl in der iOS **Kurzbefehle**-App anlegen:

| Schritt | Aktion | Einstellung |
|---|---|---|
| 1 | **Erinnerungen suchen** | Liste: `DEINE LISTE` · Filter: Nicht erledigt |
| 2 | **Wiederholen** (für jede Erinnerung) | — |
| 3 | **URL abrufen** (im Repeat-Block) | Methode: POST |

**URL:** `https://DEINE-HA-URL/api/services/todo/add_item`

**Header:**
```
Authorization: Bearer DEIN-TOKEN
Content-Type: application/json
```

**Body (JSON):**
```json
{"entity_id": "todo.aufgaben", "item": "[Aktueller Eintrag → Titel]"}
```

Für `item` den **Magic Variable**-Wert „Aktueller Eintrag → Titel" aus dem Repeat-Block verwenden.

### Automatisch ausführen

**Kurzbefehle → Automatisierung → Neu → Tageszeit**

- Uhrzeit: 08:00 und 18:00
- Aktion: Kurzbefehl ausführen

---

## Alexa → Home Assistant

> Voraussetzung: [alexa_media_player](https://github.com/alandtse/alexa_media_player) via HACS installiert und mit Amazon-Account verbunden.

1. Nach Installation prüfen: **Entwicklertools → Zustände** → nach `todo.alexa` suchen
2. Automation erstellen:

```yaml
alias: "Alexa → HA Aufgaben"
trigger:
  - platform: state
    entity_id: todo.alexa_to_do_liste   # ← echte Entity-ID einsetzen
action:
  - variables:
      neue_items: >
        {{ state_attr('todo.alexa_to_do_liste', 'items')
           | selectattr('status', 'eq', 'needs_action') | list }}
  - repeat:
      for_each: "{{ neue_items }}"
      sequence:
        - service: todo.add_item
          target:
            entity_id: todo.aufgaben
          data:
            item: "{{ repeat.item.summary }}"
  - service: todo.remove_completed_items
    target:
      entity_id: todo.alexa_to_do_liste
mode: single
```

**Sprachbefehl:** „Alexa, füge *Zahnarzt anrufen* zur To-Do-Liste hinzu"

---

## Kompatibilität

| | Status |
|---|---|
| Liquid Glass Theme | ✅ |
| Mushroom Cards | ✅ (CSS-Variablen kompatibel) |
| Dark Mode | ✅ automatisch |
| Light Mode | ✅ automatisch |
| Mobile / Tablet | ✅ |
| Kein Build-Step | ✅ Vanilla JS |

---

## Lizenz

MIT
