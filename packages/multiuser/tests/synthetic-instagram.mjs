const entryName = Buffer.from('your_instagram_activity/saved/saved_posts.json');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function singleFileZip(name, contents) {
  const checksum = crc32(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  const offset = local.length + name.length + contents.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, name, contents, central, name, end]);
}

export function syntheticSavedPosts(count = 125) {
  return Array.from({ length: count }, (_, index) => {
    const code = `Synthetic${String(index + 1).padStart(4, '0')}`;
    return {
      timestamp: 1700000000 + index,
      fbid: `synthetic-${index + 1}`,
      label_values: [
        { label: 'URL', href: `https://www.instagram.com/p/${code}/` },
        { label: '캡션', value: `테스트 장소 ${index + 1}\n서울 종로구 테스트로 ${index + 1}` },
      ],
    };
  });
}

export function syntheticSavedPostsZip(count = 125) {
  return singleFileZip(entryName, Buffer.from(JSON.stringify(syntheticSavedPosts(count))));
}
