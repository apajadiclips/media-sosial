# Panduan Pemasangan Pelayan Awan (Supabase)

Panduan ini menyambungkan `index.html` kepada projek **Supabase** percuma anda sendiri (folder `supabase/`). Selepas siap:

- **Nama akaun dikesan automatik.** Tekan **Log masuk** pada setiap kad platform, dan nama akaun sebenar dipaparkan.
- **Hantaran disiarkan sendiri** pada masa yang dijadualkan, walaupun telefon atau komputer anda ditutup.
- **Data disegerakkan merentas peranti**, termasuk profil, hashtag, draf dan senarai jadual.

Ini bahagian-bahagian Supabase yang digunakan:

| Bahagian | Kegunaan |
|---|---|
| Postgres | Akaun yang disambung (token disulitkan), hantaran dan jadual |
| Storage | Video dan thumbnail, dipadam selepas berjaya disiarkan |
| Edge Function `api` | Log masuk, OAuth dan proses siaran |
| pg_cron | Memanggil fungsi setiap minit |

> Nama menu di Supabase, Google Cloud dan Meta for Developers kerap berubah. Jika menu yang disebut tidak sama, cari nama yang hampir sama.

---

## 0. Keperluan

- Akaun **Supabase** (percuma, tiada kad): https://supabase.com/dashboard
- Akaun **Google** yang memiliki saluran YouTube anda
- Akaun **Facebook** yang menjadi admin Facebook Page anda
- Akaun **Instagram Professional** (Business/Creator) yang **dipautkan ke Facebook Page** itu
- Akaun **Threads**
- **Node.js 18+** pada komputer, untuk arahan `npx supabase`

---

## 1. Hoskan `index.html` di GitHub Pages

1. Gabungkan (merge) branch ini ke `main`.
2. GitHub → repo `media-sosial` → **Settings → Pages**.
3. Untuk **Source**, pilih *Deploy from a branch*. Untuk **Branch**, pilih `main`, folder `/ (root)`, kemudian tekan **Save**.
4. Selepas beberapa minit, aplikasi tersedia di `https://apajadiclips.github.io/media-sosial/`.

---

## 2. Cipta projek Supabase

1. Pergi ke https://supabase.com/dashboard dan pilih **New project**. Pilih rantau berhampiran, contohnya *Southeast Asia (Singapore)*.
2. Selepas projek siap, salin **Project ref** dari URL dashboard, iaitu `https://supabase.com/dashboard/project/<PROJECT_REF>`.

Dalam panduan ini:

| Nama | Nilai |
|---|---|
| `PROJECT_URL` | `https://<PROJECT_REF>.supabase.co` |
| `API_URL` | `https://<PROJECT_REF>.supabase.co/functions/v1/api` |

### Pasang pangkalan data dan fungsi

Jalankan semua arahan di bawah dari folder utama repo ini.

Log masuk ke Supabase:

```bash
npx supabase login
```

Pautkan repo ini kepada projek anda. Gantikan `PROJECT_REF` dengan nilai projek anda:

```bash
npx supabase link --project-ref PROJECT_REF
```

Cipta jadual dan bucket storan:

```bash
npx supabase db push
```

Tetapkan rahsia asas. Gantikan setiap nilai `...`. `ALLOWED_ORIGINS` sudah betul untuk GitHub Pages:

```bash
npx supabase secrets set APP_PASSWORD=... SESSION_SECRET=... ENC_KEY=... CRON_SECRET=... ALLOWED_ORIGINS=https://apajadiclips.github.io
```

| Rahsia | Keterangan |
|---|---|
| `APP_PASSWORD` | Kata laluan untuk log masuk ke aplikasi. Gunakan kata laluan yang kuat. |
| `SESSION_SECRET`, `ENC_KEY`, `CRON_SECRET` | Tiga rentetan rawak yang panjang dan **berlainan**. |

Untuk menjana setiap rentetan rawak, jalankan arahan ini sekali bagi setiap rahsia:

```bash
openssl rand -hex 32
```

> ⚠️ Jangan tukar `ENC_KEY` selepas akaun disambung. Token disulitkan dengannya, jadi jika ia ditukar, semua akaun perlu disambung semula.

Deploy fungsi `api`:

```bash
npx supabase functions deploy api --no-verify-jwt
```

`--no-verify-jwt` diperlukan kerana fungsi ini menggunakan log masuknya sendiri (`APP_PASSWORD`) dan dipanggil terus oleh Google/Meta selepas log masuk.

### Hidupkan penjadual (sekali sahaja)

1. Buka fail `supabase/cron.sql`.
2. Gantikan `GANTI_PROJECT_REF` dengan Project ref anda.
3. Gantikan `GANTI_CRON_SECRET` dengan nilai `CRON_SECRET` yang anda tetapkan tadi.
4. Salin seluruh kandungan fail ke **Supabase Dashboard → SQL Editor**, kemudian tekan **Run**.

Untuk menyemak bahawa penjadual berjalan, pergi ke **Integrations → Cron → Jobs**. Anda patut nampak `media-sosial-sender-tick` berjalan setiap minit.

---

## 3. YouTube (Google Cloud)

1. Buka https://console.cloud.google.com/ dan cipta **projek baharu**.
2. Pergi ke **APIs & Services → Library**, cari **YouTube Data API v3**, kemudian tekan **Enable**.
3. Pergi ke **Google Auth Platform / OAuth consent screen** dan tetapkan:
   - **User type:** External
   - **Scopes:** `.../auth/youtube.upload` dan `.../auth/youtube.readonly`
   - **Test users:** alamat Gmail anda
4. Pergi ke **Clients / Credentials → Create OAuth client ID** dan tetapkan:
   - **Application type:** Web application
   - **Authorized redirect URIs:** `API_URL/oauth/callback/google`
5. Simpan Client ID dan Client Secret sebagai rahsia Supabase:

```bash
npx supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
```

**Perkara penting tentang YouTube:**

- **Tukar status app ke "In production".** Selagi app berstatus **Testing**, log masuk YouTube tamat selepas 7 hari. Selepas ditukar, Google memaparkan amaran "app belum disahkan" semasa log masuk. Untuk kegunaan sendiri, tekan *Advanced → Go to …*.
- **Video terkunci Private sehingga projek diaudit.** YouTube mengunci video yang dimuat naik melalui projek API yang belum diaudit sebagai **Private**. Untuk siaran Public, mohon audit melalui borang *YouTube API Services – Audit and Quota Extension*. Sebelum audit lulus, video tetap dimuat naik, dan anda boleh menukarnya ke Public secara manual di YouTube Studio.
- **Had kuota harian.** Kuota percuma ialah 10,000 unit sehari, dan satu muat naik menggunakan kira-kira 1,600 unit. Ini bersamaan kira-kira 6 video sehari.

---

## 4. Facebook Page & Instagram (Meta for Developers)

1. Buka https://developers.facebook.com/apps dan pilih **Create app**.
2. Jika ditanya, pilih *use case* berikut:
   - **Authenticate and request data from users with Facebook Login**
   - **Manage everything on your Page**
   - **Manage messaging & content on Instagram**
3. Pastikan kebenaran ini ditambah: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`, `instagram_basic`, `instagram_content_publish`.
4. Pergi ke **Facebook Login → Settings**. Dalam **Valid OAuth Redirect URIs**, masukkan `API_URL/oauth/callback/meta`.
5. Pergi ke **App settings → Basic**, kemudian simpan App ID dan App Secret sebagai rahsia Supabase:

```bash
npx supabase secrets set META_APP_ID=... META_APP_SECRET=...
```

**Perkara penting tentang Meta:**

- **Mod Development memadai untuk kegunaan sendiri.** App boleh kekal dalam mod Development kerana ia berfungsi untuk akaun yang mempunyai peranan dalam app, iaitu anda sebagai admin.
- **Satu log masuk untuk Facebook dan Instagram.** Satu log masuk Facebook menyambungkan **kedua-dua** kad Facebook dan Instagram. Jika anda ada beberapa Page, aplikasi meminta anda memilih satu.
- **Versi Graph API.** Kod menggunakan versi `v23.0`. Jika Meta sudah menamatkan versi itu, tetapkan versi semasa (semak di https://developers.facebook.com/docs/graph-api/changelog):

```bash
npx supabase secrets set GRAPH_VERSION=v24.0
```

---

## 5. Threads

1. Dalam app Meta yang sama, tambah use case **Access the Threads API**.
2. Tambah kebenaran `threads_basic` dan `threads_content_publish`.
3. Dalam **Threads settings**, tetapkan **Redirect Callback URL** kepada `API_URL/oauth/callback/threads`. Jika diminta, masukkan URL yang sama untuk *Uninstall* dan *Delete* callback.
4. Pergi ke **App roles → Roles → Threads Testers** dan tambah nama pengguna Threads anda.
5. Di Threads (web atau app), buka **Settings → Account → Website permissions → Invites**, kemudian **terima** jemputan itu.
6. Simpan **Threads App ID** dan **Threads App Secret** sebagai rahsia Supabase. Nilai ini **berbeza** daripada Meta App ID.

```bash
npx supabase secrets set THREADS_APP_ID=... THREADS_APP_SECRET=...
```

Rahsia baharu terpakai serta-merta, jadi fungsi tidak perlu di-deploy semula.

---

## 6. Mula guna

1. Buka aplikasi di GitHub Pages dan tekan butang **Awan** di header.
2. Masukkan **URL projek Supabase** (`PROJECT_URL`, contohnya `https://abcd1234.supabase.co`) dan **APP_PASSWORD**, kemudian tekan **Log masuk**.
3. Pilih profil, contohnya `apajadiclips`, dan tekan **Log masuk** pada setiap kad platform. Nama akaun sebenar akan dipaparkan bersama titik hijau.
4. Ulang untuk profil lain, contohnya `shazclipper` dengan akaun Google atau Facebook yang lain.
5. Muat naik video, isi tajuk dan kapsyen, tetapkan masa, kemudian tekan **Schedule All Posts → Sahkan & Jadualkan Sekarang**.
6. Ikuti status setiap platform dalam **Jadual**: *Dijadualkan → Sedang dihantar → Disiarkan*, berserta pautan **Lihat siaran**. Jika gagal, sebabnya dipaparkan dan anda boleh tekan **Cuba semula**.

Tanpa log masuk ke pelayan, aplikasi kekal dalam mod setempat seperti sebelum ini.

---

## Had pelan percuma Supabase & nota

| Perkara | Keterangan |
|---|---|
| Saiz video | **Maksimum 50 MB** setiap fail pada pelan percuma. Aplikasi memberi amaran jika video lebih besar. Video 1080p sepanjang 60 saat biasanya 20–60 MB. |
| Storan | 1 GB. Video dipadam selepas semua platform berjaya disiarkan. Jika siaran gagal, video disimpan 3 hari supaya boleh dicuba semula. |
| Projek dijeda | Supabase menjeda projek percuma yang tidak aktif. Jika projek dijeda, buka dashboard dan tekan **Restore project**. |
| Kualiti (360p–2K) | Hanya label. Pelayan **tidak** menukar resolusi, jadi eksport video pada kualiti yang dikehendaki sebelum muat naik. |
| Kapsyen | Instagram: maksimum 2,200 aksara. Threads: maksimum 500 aksara (dipotong secara automatik). Pada Instagram dan Threads, tajuk diletakkan di atas kapsyen. |
| YouTube Shorts | Video 9:16 yang ≤ 3 minit dikira sebagai Shorts. `#Shorts` ditambah secara automatik. |
| Thumbnail | **YouTube:** perlukan saluran yang disahkan. **Instagram:** digunakan sebagai cover. **Facebook:** tidak disokong. |
| Keselamatan | Jadual pangkalan data dilindungi RLS, jadi kunci awam tidak boleh membacanya. Token akaun disulitkan dengan AES-GCM. Jangan kongsi `APP_PASSWORD`. |

## Jika ada masalah

- **Log fungsi:** Dashboard → **Edge Functions → api → Logs**.
- **Ralat kunci / "Invalid API key":**
  1. Pergi ke Dashboard → **Project Settings → API Keys** dan salin kunci `service_role` dan `anon`. Jika projek anda menggunakan kunci baharu, salin kunci *secret* dan *publishable*.
  2. Tetapkan kedua-duanya sebagai rahsia:

     ```bash
     npx supabase secrets set SERVICE_ROLE_KEY=... ANON_KEY=...
     ```

- **Jadual tidak berjalan:** semak **Integrations → Cron → Jobs → History**, dan pastikan `CRON_SECRET` dalam `cron.sql` sama dengan rahsia fungsi.
- **"Asal … tiada dalam ALLOWED_ORIGINS":** tetapkan `ALLOWED_ORIGINS` kepada asal laman anda, contohnya `https://apajadiclips.github.io`. Jangan sertakan `/media-sosial/`.
