import crypto from 'node:crypto';
import fs from 'node:fs'

(() => {
  const filePath = process.argv[2];
  if(filePath == null || String(filePath).trim() === '') return console.error('Please Input File Name');
  if(!fs.existsSync(filePath)) return console.error('The File Does Not Exist');
  
  const file = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(file).digest('base64url');
  console.log(hash.substring(0, 8));
})();
