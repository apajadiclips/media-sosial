# Panduan Pemasangan Pelayan Awan (Pilihan 3)

Panduan ini menyambungkan `index.html` kepada pelayan kecil percuma di Cloudflare (`worker/`). Selepas siap:

- Tekan **Log masuk** pada setiap kad platform, dan nama akaun sebenar dikesan secara automatik.
- Hantaran disiarkan sendiri pada masa dijadualkan, walaupun telefon atau komputer anda ditutup.
- Profil, hashtag dan draf disegerakkan antara semua peranti selepas log masuk ke pelayan.

> Nama menu di Google Cloud dan Meta for Developers kerap berubah. Jika menu yang disebut di bawah tidak sama, cari nama yang hampir sama.

---

## 0. Keperluan

- Akaun **Cloudflare** (percuma): https://dash.cloudflare.com/sign-up
- Akaun **Google** yang memiliki saluran YouTube anda
- Akaun **Facebook** yang menjadi admin Facebook Page anda
- Akaun **Instagram Professional** (Business/Creator) yang **dipautkan ke Facebook Page** itu
- Akaun **Threads**
- **Node.js 18+** pada komputer (untuk arahan `npx wrangler`)

---

## 1. Hoskan `index.html` di GitHub Pages

1. Gabungkan (merge) branch ini ke `main`.
2. GitHub → repo `media-sosial` → **Settings → Pages**.
3. **Source:** *Deploy from a branch*. **Branch:** `main`, folder `/ (root)`. Kemudian tekan **Save**.
4. Selepas beberapa minit, aplikasi boleh dibuka di `https://apajadiclips.github.io/media-sosial/`.

Asal (origin) laman ini ialah `https://apajadiclips.github.io`. Nilai itu sudah ditetapkan dalam `worker/wrangler.toml` (`ALLOWED_ORIGINS`).

---

## 2. Cloudflare Worker, D1 & R2

Dari folder `worker/`:

```bash
cd worker
```

```bash
npm install
```

```bash
npx wrangler login
```

Cipta pangkalan data D1:

```bash
npx wrangler d1 create media-sosial-sender
```

Salin `database_id` yang dipaparkan, kemudian tampal ke dalam `wrangler.toml` menggantikan `GANTI_DENGAN_D1_DATABASE_ID`.

Cipta storan video R2. Cloudflare mungkin meminta anda mengaktifkan R2 dan menambah kaedah bayaran dahulu, tetapi 10 GB pertama percuma:

```bash
npx wrangler r2 bucket create media-sosial-sender-media
```

Cipta jadual dalam D1:

```bash
npm run db:init
```

Tetapkan 3 rahsia asas. Setiap arahan akan meminta anda menaip nilainya:

```bash
npx wrangler secret put APP_PASSWORD
```

```bash
npx wrangler secret put SESSION_SECRET
```

```bash
npx wrangler secret put ENC_KEY
```

- `APP_PASSWORD`: kata laluan untuk log masuk ke aplikasi. Gunakan kata laluan yang kuat.
- `SESSION_SECRET` dan `ENC_KEY`: rentetan rawak yang panjang. Anda boleh jana dengan arahan di bawah:

```bash
openssl rand -base64 32
```

> ⚠️ Jangan tukar `ENC_KEY` selepas ini. Token akaun disulitkan dengannya, jadi jika ia ditukar semua akaun perlu disambung semula.

Deploy kali pertama:

```bash
npm run deploy
```

Wrangler akan memaparkan URL seperti `https://media-sosial-sender-api.NAMAANDA.workers.dev`. Salin URL itu ke `PUBLIC_URL` dalam `wrangler.toml`, kemudian deploy semula:

```bash
npm run deploy
```

Dalam langkah 3–5 di bawah, `PUBLIC_URL` merujuk kepada URL ini.

---

## 3. YouTube (Google Cloud)

1. Buka https://console.cloud.google.com/ dan cipta **projek baharu**.
2. **APIs & Services → Library**. Cari **YouTube Data API v3**, kemudian tekan **Enable**.
3. **Google Auth Platform / OAuth consent screen**:
   - **User type:** External
   - **Scopes:** tambah `.../auth/youtube.upload` dan `.../auth/youtube.readonly`
   - **Test users:** tambah alamat Gmail anda
4. **Clients / Credentials → Create OAuth client ID**:
   - **Application type:** Web application
   - **Authorized redirect URIs:** `PUBLIC_URL/oauth/callback/google`
5. Simpan Client ID dan Client Secret ke Worker:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

**Perkara penting tentang YouTube:**

- **Log masuk tamat selepas 7 hari jika app dalam mod "Testing".** Selagi app dalam mod Testing, Google tamatkan log masuk selepas 7 hari. Tukar **Publishing status** kepada **In production** supaya ia tidak tamat. Google akan memaparkan amaran "app belum disahkan" semasa log masuk. Untuk kegunaan sendiri, tekan *Advanced → Go to …*.
- **Video terkunci "Private" sehingga projek lulus audit.** YouTube mengunci video yang dimuat naik melalui projek API yang belum diaudit pada mod **Private**. Untuk siaran Public, mohon audit melalui borang *YouTube API Services – Audit and Quota Extension*. Sebelum lulus, video tetap dimuat naik dan anda boleh tukar ke Public secara manual di YouTube Studio.
- **Had kuota harian.** Kuota percuma ialah 10,000 unit sehari, dan satu muat naik menggunakan kira-kira 1,600 unit. Jadi had anda kira-kira 6 video sehari.

---

## 4. Facebook Page & Instagram (Meta for Developers)

1. Buka https://developers.facebook.com/apps dan pilih **Create app**.
2. Pilih *use case* berikut (jika ditanya):
   - **Authenticate and request data from users with Facebook Login**
   - **Manage everything on your Page**
   - **Manage messaging & content on Instagram**
3. Pastikan kebenaran berikut ditambah: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`, `instagram_basic`, `instagram_content_publish`.
4. **Facebook Login → Settings → Valid OAuth Redirect URIs:** `PUBLIC_URL/oauth/callback/meta`
5. **App settings → Basic**. Salin **App ID** dan **App Secret**, kemudian simpan ke Worker:

```bash
npx wrangler secret put META_APP_ID
```

```bash
npx wrangler secret put META_APP_SECRET
```

**Perkara penting tentang Meta:**

- **Mod Development memadai untuk kegunaan sendiri.** App boleh kekal dalam mod Development, kerana mod ini berfungsi untuk akaun yang mempunyai peranan dalam app (anda sebagai admin). App Review hanya perlu jika orang lain akan menggunakannya.
- **Satu log masuk untuk Facebook dan Instagram.** Satu log masuk Facebook menyambungkan **kedua-dua** kad Facebook dan Instagram, jika Page itu mempunyai IG Professional yang dipautkan. Jika anda ada beberapa Page, aplikasi akan meminta anda memilih satu.
- **Semak versi Graph API.** `GRAPH_VERSION` dalam `wrangler.toml` ditetapkan kepada `v23.0`. Semak versi semasa di https://developers.facebook.com/docs/graph-api/changelog dan kemas kini jika versi itu sudah tamat.

---

## 5. Threads

1. Dalam app Meta yang sama, tambah use case **Access the Threads API**.
2. Tambah kebenaran `threads_basic` dan `threads_content_publish`.
3. **Threads settings:**
   - **Redirect Callback URL:** `PUBLIC_URL/oauth/callback/threads`
   - Masukkan URL yang sama untuk *Uninstall* dan *Delete* callback jika diminta.
4. **App roles → Roles → Threads Testers**. Tambah nama pengguna Threads anda.
5. Buka Threads (web atau app) → **Settings → Account → Website permissions → Invites**, kemudian **terima** jemputan itu.
6. Salin **Threads App ID** dan **Threads App Secret**. Nilai ini **berbeza** daripada Meta App ID. Simpan ke Worker:

```bash
npx wrangler secret put THREADS_APP_ID
```

```bash
npx wrangler secret put THREADS_APP_SECRET
```

---

## 6. Mula guna

1. Buka aplikasi di GitHub Pages dan tekan butang **Awan** di header.
2. Masukkan **URL Worker** (`PUBLIC_URL`) dan **APP_PASSWORD**, kemudian tekan **Log masuk**.
3. Pilih profil (contohnya `apajadiclips`). Pada setiap kad platform, tekan **Log masuk**. Nama akaun sebenar akan dipaparkan dengan titik hijau.
4. Ulang langkah 3 untuk profil lain, contohnya `shazclipper` dengan akaun Google atau Facebook yang lain.
5. Muat naik video, isi tajuk dan kapsyen, tetapkan masa, kemudian tekan **Schedule All Posts → Sahkan & Jadualkan Sekarang**.
6. Ikuti status setiap platform dalam **Jadual**: Dijadualkan → Sedang dihantar → Disiarkan, berserta pautan **Lihat siaran**. Jika gagal, sebab kegagalan dipaparkan dan anda boleh tekan **Cuba semula**.

Tanpa log masuk ke pelayan, aplikasi kekal dalam mod setempat seperti sebelum ini.

---

## Had & nota

| Perkara | Keterangan |
|---|---|
| Kos | Semua dalam had percuma Cloudflare. Cron setiap minit ≈ 1,440 permintaan sehari, manakala had percuma ialah 100,000 sehari. Video dipadam daripada R2 selepas semua platform berjaya disiarkan. |
| Saiz video | Fail besar dimuat naik dalam bahagian 20 MB, jadi had 100 MB setiap permintaan Worker tidak menjadi masalah. |
| Kualiti (360p–2K) | Hanya label. Pelayan **tidak** menukar resolusi video, jadi eksport video pada kualiti yang dikehendaki sebelum muat naik. |
| Kapsyen | Instagram: maksimum 2,200 aksara. Threads: maksimum 500 aksara (dipotong secara automatik). Untuk Instagram dan Threads, tajuk digabungkan di atas kapsyen. |
| YouTube Shorts | Video 9:16 yang ≤ 3 minit menjadi Shorts. `#Shorts` ditambah secara automatik pada video 9:16. |
| Thumbnail | YouTube: memerlukan saluran yang disahkan (verified). Instagram: digunakan sebagai cover. Facebook: tidak disokong melalui cara ini. |
| Token | Pelayan memperbaharui token YouTube dan Threads secara automatik. Jika status menunjukkan "sila sambung semula", tekan Putus dan Log masuk semula. |
| Keselamatan | Token akaun disulitkan (AES-GCM) dalam D1. Pautan video untuk Meta ditandatangani dan tamat selepas 12 jam. Jangan kongsi `APP_PASSWORD`. |

## Uji di komputer sendiri (pilihan)

1. Dalam `worker/`, cipta fail `.dev.vars` yang mengandungi rahsia di atas, satu `NAMA=nilai` setiap baris. Fail ini tidak di-commit.
2. Cipta jadual dalam D1 setempat:

```bash
npm run db:init:local
```

3. Jalankan Worker setempat. `--test-scheduled` membolehkan anda mencetuskan cron secara manual melalui `/__scheduled`:

```bash
npx wrangler dev --test-scheduled --var PUBLIC_URL:http://localhost:8787 --var ALLOWED_ORIGINS:http://localhost:8080
```

4. Hidangkan `index.html` dari folder utama repo:

```bash
python3 -m http.server 8080
```

5. Buka `http://localhost:8080`, tekan **Awan**, dan gunakan URL `http://localhost:8787`.

Log masuk sebenar ke platform tidak boleh diuji secara setempat, kerana redirect URI mestilah `PUBLIC_URL` yang berdaftar.
