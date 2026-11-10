# ✦ AI Studio

Code • ZIP projects • Design • Premium PDF • Image analyzer — freemodel.in API par.
**Zero dependency** (sirf Node 18+). `npm install` ki zaroorat nahi.

## Chalane ka tareeka
1. `cp .env.example .env` aur `FREEMODEL_API_KEY` daalo (ya app me ⚙ Settings se).
2. `node server.js` → http://localhost:3000

## Features
- **Auto mode** (best model khud chunta hai, fail ho to agla try) + **Manual** model select
- Coding: complete project files → **ZIP download** (chat me card), 10–50 MB base ZIP bhi support
- **Auto-fix**: syntax / JSON / missing imports / missing files / package.json deps khud check karke AI se theek karwata hai (3 rounds)
- 📎 File, **ZIP upload (150 MB tak)**, docx/xlsx/pptx/pdf text, **image analyzer** (OCR + errors)
- HTML design **live preview**, **PDF design** (Chrome se vector PDF, Hindi support) chat me preview
- **🎛 Full Control switch** (header): ON = AI jo bolo wahi poora karega (sawal/lecture nahi), OFF = normal
- Undo, edit/regenerate, project file editor, live preview, templates (✨), voice typing (🎤), read-aloud (🔊)
- Chat search/pin/rename, export .md, backup/restore, dark/light theme, custom instructions

## PDF ke liye
Server machine par Google Chrome / Chromium chahiye (auto-detect, ya `CHROME_PATH`). Na ho to HTML preview + browser Print milta hai.

## Deploy (Render)
`render.yaml` included. Env var `FREEMODEL_API_KEY` set karo. PDF ke liye Docker image me chromium add karna hoga.

## Security
API key browser me save hoti hai aur server ke through freemodel.in ko jaati hai. Public deploy par `APP_PASSWORD` zaroor set karo.
