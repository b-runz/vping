const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { EmailClient } = require("@azure/communication-email");
require('dotenv').config()
const { firefox } = require("playwright-firefox");
const PNG = require('pngjs').PNG;

const AZURE_STORAGE_CONNECTION_STRING = 
  process.env.AZURE_STORAGE_CONNECTION_STRING;
  
const emailConnectionString = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING;

if (!AZURE_STORAGE_CONNECTION_STRING) {
  throw Error('Azure Storage Connection string not found');
}

// Create the BlobServiceClient object with connection string
const blobServiceClient = BlobServiceClient.fromConnectionString(
    AZURE_STORAGE_CONNECTION_STRING
);


const emailClient = new EmailClient(emailConnectionString);

async function compareImages(buffer1, buffer2, thresholdPercent = 1) {
    const pixelmatch = (await import('pixelmatch')).default;
    
    // Validate buffers
    if (!Buffer.isBuffer(buffer1) || !Buffer.isBuffer(buffer2)) {
        throw new Error('Inputs must be Buffer objects');
    }

    // Parse buffers into PNG objects
    let img1, img2;
    try {
        img1 = PNG.sync.read(buffer1);
        img2 = PNG.sync.read(buffer2);
    } catch (error) {
        throw new Error('Invalid PNG buffer: ' + error.message);
    }

    // Check if images have the same dimensions
    if (img1.width !== img2.width || img1.height !== img2.height) {
        console.log(`Dimension mismatch detected: ${img1.width}x${img1.height} vs ${img2.width}x${img2.height}`);
        return { diffPercent: 100, diffBuffer: null, hasChanged: true, dimensionMismatch: true };
    }

    const { width, height } = img1;
    const diff = new PNG({ width, height });

    // Compare images using pixelmatch
    const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });

    // Calculate percentage of changed pixels
    const totalPixels = width * height;
    const diffPercent = (numDiffPixels / totalPixels) * 100;

    // Log if difference exceeds threshold
    if (diffPercent > thresholdPercent) {
        console.log(`Image change detected: ${diffPercent.toFixed(2)}% of pixels differ`);
        return { diffPercent, diffBuffer: PNG.sync.write(diff), hasChanged: true, dimensionMismatch: false };
    } else {
        console.log(`No significant change detected: ${diffPercent.toFixed(2)}% of pixels differ`);
        return { diffPercent, diffBuffer: null, hasChanged: false, dimensionMismatch: false };
    }
}

async function downloadBlobAsBuffer(containerName, blobName) {
    try {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        // Download the blob as a buffer
        const downloadResponse = await blockBlobClient.download();
        const chunks = [];
        
        for await (const chunk of downloadResponse.readableStreamBody) {
            chunks.push(chunk);
        }
        
        return Buffer.concat(chunks);
    } catch (error) {
        console.log(`Error downloading blob ${blobName}: ${error.message}`);
        return null;
    }
}

async function uploadBufferToBlob(containerName, blobName, buffer) {
    try {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        // Upload the buffer, overwriting existing blob
        await blockBlobClient.upload(buffer, buffer.length, {
            blobHTTPHeaders: { blobContentType: 'image/png' }
        });
        
        console.log(`Successfully uploaded ${blobName}`);
        return true;
    } catch (error) {
        console.log(`Error uploading blob ${blobName}: ${error.message}`);
        return false;
    }
}

async function sendEmail(screenshotBuffer) {
  try {
    // Convert screenshot to base64 data URL
    const base64Image = screenshotBuffer.toString('base64');
    const imageDataUrl = `data:image/png;base64,${base64Image}`;
    
    // Define email message
    const emailMessage = {
      senderAddress: process.env.SENDER_EMAIL_ADDRESS,
      content: {
        subject: "Update on website GrimFest",
        plainText: "There has been an update on the website. Please view this email in HTML format to see the screenshot.",
        html: `
          <h2>Website Update Detected</h2>
          <p>There has been an update on the website GrimFest.</p>
          <p>Here is the current screenshot of the webpage:</p>
          <img src="${imageDataUrl}" alt="Current webpage screenshot" style="max-width: 100%; height: auto; border: 1px solid #ccc; margin: 10px 0;">
          <p>This screenshot was captured automatically when a change was detected.</p>
        `
      },
      recipients: {
        to: [
          {
            address: process.env.RECPT_EMAIL_ADRESS,
            displayName: process.env.RECPT_EMAIL_ADRESS
          }
        ],
      }
    };

    // Send email and poll for completion
    const poller = await emailClient.beginSend(emailMessage);
    const result = await poller.pollUntilDone();
    console.log("Email sent successfully:", result);
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

app.timer('DetectChange', {
    schedule: '0 */5 * * * *',
    handler: async (myTimer, context) => {
        context.log(`Http function processed request for url "${request.url}"`);

        const url = 'https://grimfest.unitedtickets.dk/rd/event/grimfest-2025/grimfest/3105980';
        const containerName = 'vping'; // Replace with your actual container name
        const blobName = 'before.png';

        try {
            // 1. Download the existing before.png from blob storage
            const beforeImageBuffer = await downloadBlobAsBuffer(containerName, blobName);
            
            // 2. Capture the webpage
            const browser = await firefox.launch();
            const page = await browser.newPage();
            await page.goto(url);
            const newScreenshotBuffer = await page.screenshot({ fullPage: true });
            await browser.close();

            // 3. Compare images if before.png exists
            if (beforeImageBuffer) {
                const comparison = await compareImages(beforeImageBuffer, newScreenshotBuffer);
                
                // 4. Respond based on comparison result
                if (comparison.hasChanged) {
                    // 5. If not equal (or dimension mismatch), overwrite the before.png on blob storage
                    if (comparison.dimensionMismatch) {
                        context.log('Dimension mismatch detected - uploading new screenshot');
                    } else {
                        context.log('Content change detected - uploading new screenshot');
                    }
                    await uploadBufferToBlob(containerName, blobName, newScreenshotBuffer);

                    await sendEmail(newScreenshotBuffer);
                    return {
                        body: "not equal",
                        headers: {
                            'content-type': 'text/plain'
                        }
                    };
                } else {
                    return {
                        body: "equal",
                        headers: {
                            'content-type': 'text/plain'
                        }
                    };
                }
            } else {
                // If before.png doesn't exist, save the new screenshot as before.png
                context.log('No existing before.png found - uploading new screenshot');
                await uploadBufferToBlob(containerName, blobName, newScreenshotBuffer);
                await sendEmail(newScreenshotBuffer);
                return {
                    body: "not equal",
                    headers: {
                        'content-type': 'text/plain'
                    }
                };
            }
        } catch (error) {
            context.log(`Error: ${error.message}`);
            return {
                body: `Error: ${error.message}`,
                headers: {
                    'content-type': 'text/plain'
                },
                status: 500
            };
        }
    }
});

