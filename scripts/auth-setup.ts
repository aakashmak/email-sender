import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';
import { google } from 'googleapis';

dotenv.config();

const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env file');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('Gmail OAuth Setup');
  console.log('=================\n');
  console.log('Step 1: Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...\n');

  // Start local server to receive the callback
  const refreshToken = await new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost:3000');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.end(`<h1>Error: ${error}</h1>`);
        server.close();
        reject(new Error(error));
        return;
      }

      if (!code) {
        res.end('<h1>No code received</h1>');
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);
        res.end('<h1>Authorization successful! You can close this tab.</h1>');
        server.close();
        resolve(tokens.refresh_token!);
      } catch (err) {
        res.end('<h1>Failed to get token. Check console.</h1>');
        server.close();
        reject(err);
      }
    });

    server.listen(3000, () => {
      console.log('Listening on http://localhost:3000 ...');
    });

    server.on('error', reject);
  });

  console.log('\n=== SUCCESS ===\n');
  console.log('Refresh token:', refreshToken);

  // Save refresh token to .env
  const envPath = path.resolve(process.cwd(), '.env');
  let envContent = fs.readFileSync(envPath, 'utf-8');
  envContent = envContent.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, `GMAIL_REFRESH_TOKEN=${refreshToken}`);
  fs.writeFileSync(envPath, envContent);
  console.log('✓ Saved GMAIL_REFRESH_TOKEN to .env');

  // Update GitHub environment secret
  try {
    execSync(`gh secret set GMAIL_REFRESH_TOKEN --env email-sender --body "${refreshToken}"`, { stdio: 'pipe' });
    console.log('✓ Updated GitHub secret (email-sender environment)');
  } catch {
    console.log('✗ GitHub secret update failed — update GMAIL_REFRESH_TOKEN manually in GitHub Actions secrets');
  }

  console.log('\nDone!');
}

main().catch(console.error);
