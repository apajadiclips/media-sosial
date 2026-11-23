# Media Sosial Sender

PWA satu fail (`index.html`) untuk menyediakan dan menjadualkan hantaran merentas YouTube Shorts, Facebook, Instagram dan Threads — tanpa langganan. Spesifikasi asal dalam [`MASTER_PROMPT.md`](MASTER_PROMPT.md).

## Dua mod

| Mod | Apa berlaku |
|---|---|
| **Setempat** (lalai) | Semua data dalam pelayar peranti. Nama akaun ditaip sendiri. Jadual hanya direkod, tidak disiarkan. Guna Export/Import JSON untuk pindah antara peranti. |
| **Awan** (butang **Awan**) | Disambung ke projek Supabase anda sendiri ([`supabase/`](supabase/)). Log masuk sebenar ke setiap platform (nama akaun dikesan automatik), video disiarkan sendiri pada masa dijadualkan, data disegerakkan merentas peranti. |

Langkah pemasangan mod awan: **[SETUP.md](SETUP.md)**.

## Guna di telefon

Hoskan `index.html` di HTTPS (cth. GitHub Pages), buka di Chrome, kemudian **⋮ → Add to Home screen / Install app**.
