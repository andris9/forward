# forward

Example email forwarder with ARC support

## Usage

1. Generate certificate/key files for STARTTLS and ARC signing
2. Edit [configuration file](config/default.toml), set port nr (should be 25) and key locations. Also configure virtual alias map
3. Install dependencies with `npm install`
4. Run the app `sudo node server.js` (sudo is required for port 25)
