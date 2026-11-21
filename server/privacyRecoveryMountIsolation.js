import path from 'node:path';

function decodeMountField(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function parseMountInfo(mountInfo) {
  if (typeof mountInfo !== 'string' || !mountInfo.trim()) {
    throw new Error('privacy_recovery_mountinfo_unavailable');
  }
  const mounts = [];
  for (const line of mountInfo.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(' - ');
    if (separator < 0) throw new Error('privacy_recovery_mountinfo_malformed');
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    if (before.length < 6 || after.length < 3) {
      throw new Error('privacy_recovery_mountinfo_malformed');
    }
    mounts.push({
      mountPoint: path.resolve(decodeMountField(before[4])),
      mountOptions: new Set(before[5].split(',')),
      filesystem: after[0]
    });
  }
  return mounts;
}

export function assertPrivateMediaRootsReadOnly({ mountInfo, storageRoots }) {
  const mounts = parseMountInfo(mountInfo);
  for (const [queue, root] of Object.entries(storageRoots || {})) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error('privacy_recovery_readonly_storage_root_invalid:' + queue);
    }
    const absoluteRoot = path.resolve(root);
    const covering = mounts
      .filter(mount => isWithin(mount.mountPoint, absoluteRoot))
      .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
    if (!covering || !covering.mountOptions.has('ro')) {
      throw new Error('privacy_recovery_storage_mount_not_read_only:' + queue);
    }
  }
  return { verifiedReadOnlyMountCount: Object.keys(storageRoots).length };
}
