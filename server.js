'use strict';

const config = require('wild-config');
const { SMTPServer } = require('smtp-server');
const { authenticate } = require('mailauth');
const os = require('os');
const util = require('util');
const mxConnect = util.promisify(require('mx-connect'));
const { createTransport } = require('nodemailer');
const fs = require('fs');

// override key files with key values
config.arc = Object.assign(config.arc, {
    privateKey: fs.readFileSync(config.arc.privateKey)
});
config.mx.tls = Object.assign(config.mx.tls, {
    key: fs.readFileSync(config.mx.tls.key),
    cert: fs.readFileSync(config.mx.tls.cert)
});

const generateReceivedHeader = (session, hostname) => {
    return `Received: from ${session.remoteAddress} by ${hostname} with ${session.transmissionType} id ${session.id}
 ${new Date().toUTCString().replace(/GMT/, '+0000')}`;
};

/**
 * Function to deliver email to forwarding destination
 *
 * @param {String} id Session ID for logging
 * @param {String} from Envelope RCPT TO address (can be empty)
 * @param {Object} to Recipient info
 * @param {String} to.original Initial MAIL TO address
 * @param {String} to.target Forarded MAIL FROM address
 * @param {Buffer} message RFC822 formatted message
 */
const forward = async (id, from, to, message) => {
    // deliver message to recipient

    console.log(`[${id}] Sending mail to ${to.target}`);

    let connection = await mxConnect(to.target);
    if (!connection?.socket) {
        console.error(`[${id}] Failed to get connection to MX of ${to}`);
        return;
    }

    let transporter = createTransport({
        host: connection.hostname,
        port: connection.port,

        auth: false,
        debug: true,
        logger: true,

        connection: connection.socket
    });

    message = Buffer.concat([
        Buffer.from([`X-Forwarded-To: ${to.target}`, `X-Forwarded-For: ${to.original} ${to.target}`, `Delivered-To: ${to.original}`].join('\r\n') + '\r\n'),
        message
    ]);

    try {
        await transporter.sendMail({
            envelope: { from, to: [to.target] },
            raw: message
        });
    } catch (err) {
        console.log(err);
    }
};

/**
 * Function to generate authentication headers and calling forarding function for each target
 *
 * @param {Buffer} message RFC822 formatted message
 * @param {Object} session Session information from smtp-server
 */
const processMessage = async (message, session) => {
    const sender = (session.envelope.mailFrom && session.envelope.mailFrom.address) || '';
    const { headers } = await authenticate(message, {
        ip: session.remoteAddress, // SMTP client IP
        helo: session.hostNameAppearsAs || session.clientHostname, // EHLO/HELO hostname
        mta: config.mx.servername || os.hostname(), // server processing this message, defaults to os.hostname()
        sender, // MAIL FROM address
        seal: config.arc
    });

    // add message headers
    message = Buffer.concat([Buffer.from(headers), message]);

    // resolve recipients from  virtual alias table

    let targetList = session.envelope.rcptTo.flatMap((rcpt, i) => {
        let list = config.addresses.find(addr => addr.address === rcpt.address);
        return list?.targets?.map(target => {
            return {
                original: rcpt.address,
                target
            };
        });
    });

    for (let i = 0; i < targetList.length; i++) {
        let rcpt = targetList[i];
        await forward(`${session.id}.${i + 1}`, sender, rcpt, message);
    }

    return session.id;
};

// Setup server
const server = new SMTPServer({
    // log to console
    logger: true,
    secure: false,

    // StartTLS keys
    key: config.mx.tls.key,
    cert: config.mx.tls.cert,

    name: config.mx.servername,

    // not required but nice-to-have
    banner: 'Welcome to forwarder service',

    // disable STARTTLS to allow authentication in clear text mode
    disabledCommands: ['AUTH'],

    // Accept messages up to 10 MB
    size: 10 * 1024 * 1024,

    onMailFrom(address, session, callback) {
        // accept anything
        callback();
    },

    // Validate RCPT TO envelope address. Example allows all addresses that do not start with 'deny'
    // If this method is not set, all addresses are allowed
    onRcptTo(address, session, callback) {
        let err;

        // allow only targets listed in the config file
        if (!config.addresses.some(a => a.address === address.address)) {
            return callback(new Error('Unknown user'));
        }

        callback();
    },

    // Handle message stream
    onData(stream, session, callback) {
        let sender = (session.envelope.mailFrom && session.envelope.mailFrom.address) || '';
        let transmissionHeaders = [`Return-Path: <${sender}>`, generateReceivedHeader(session, config.mx.servername || os.hostname())];

        let chunks = [],
            chunklen = 0;

        transmissionHeaders.forEach(h => {
            let chunk = Buffer.from(h.replace(/\r?\n/g, '\r\n') + '\r\n');
            chunks.push(chunk);
            chunklen += chunk.length;
        });

        stream.on('readable', () => {
            let chunk;
            while ((chunk = stream.read()) !== null) {
                chunks.push(chunk);
                chunklen += chunk.length;
            }
        });

        stream.on('end', () => {
            let err;
            if (stream.sizeExceeded) {
                err = new Error('Error: message exceeds fixed maximum allowed message size');
                err.responseCode = 552;
                return callback(err);
            }

            const message = Buffer.concat(chunks, chunklen);
            processMessage(message, session)
                .then(queueId => callback(null, `Message queued as ${queueId}`))
                .catch(err => {
                    console.error(err);
                    callback(err);
                });
        });
    }
});

server.on('error', err => {
    console.log('Error occurred');
    console.log(err);
});

// start listening
server.listen(config.mx.port, config.mx.host);
