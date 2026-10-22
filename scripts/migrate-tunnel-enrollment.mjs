import fs from 'node:fs';import path from 'node:path';import {loadPublic,saveSecret,dataPath} from '../src/tunnel-store.mjs';
const old=path.join(dataPath(),'enrollment.json');const row=loadPublic('enrollment');if(row?.id){saveSecret('enrollment',row);fs.unlinkSync(old);console.log('ENROLLMENT_SECURED')}else console.log('NO_MIGRATION_NEEDED');
