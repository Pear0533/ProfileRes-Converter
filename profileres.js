const fs = require("fs");
const zlib = require("zlib");
const iconv = require("iconv-lite");
const Float = require("number-util");
const ROOT_DIR = ".";
const FILENAME = process.argv[2];

var revision = null;
var fileData = null;
var fileExt = null;
var forStreaming = null;
var reference = 0;
var branchID = 0;
var branchRevision = 0;
var nextIndex = 0;
var comFlags = 7;
var filePos = {};
var refIDs = {};
var refObjs = new Array(1);
var output = [];

function readVarint() {
    let result = 0,
        i = 0;
    while (true) {
        let b = (fileData.slice(filePos.offset, filePos.offset + 1).readUInt8()) & 0xFF;
        filePos.offset++;
        result |= (b & 0x7F) << 7 * i;
        if ((b & 0x80) == 0) break;
        i++;
    }
    return result >>> 0;
}

function readInt8() {
    let result = fileData.slice(filePos.offset, filePos.offset + 1).readUInt8();
    filePos.offset++;
    return result;
}

function readInt8a(size) {
    let arr = [];
    for (let i = 0; i < size; ++i)
        arr.push(readInt8());
    return arr;
}

function readBool() {
    return readInt8() != 0;
}

function readInt16() {
    let result = fileData.slice(filePos.offset, filePos.offset + 2).readUInt16BE();
    filePos.offset += 2;
    return result;
}

function readInt32f() {
    let result = fileData.slice(filePos.offset, filePos.offset + 4).readUInt32BE();
    filePos.offset += 4;
    return result;
}

function readInt32() {
    return Math.abs((comFlags == 0 ? readInt32f() : readVarint()));
}

function writeBytes(bytes) {
    for (let i = 0; i < bytes.length; ++filePos.offset, ++i)
        output.push(bytes[i]);
}

function writeInt8(value) {
    output.push(value);
    filePos.offset++;
}

function writeInt8a(values) {
    values.forEach(val => {
        output.push(val);
        filePos.offset++;
    });
}

function writeVarint(value) {
    if (value == -1) {
        writeBytes(new Array(0xFF, 0xFF, 0xFF, 0xFF, 0x0F));
        return;
    } else if (value == 0) {
        writeInt8(0);
        return;
    }
    while (value > 0) {
        let b = value;
        value >>>= 7;
        if (value > 0) b |= 128;
        writeInt8(b);
    }
}

function intToBytes(value) {
    return new Array((value >>> 24), (value >>> 16), (value >> 8), value);
}

function writeBool(value) {
    writeInt8(value == true ? 1 : 0);
}

function shortToBytes(value) {
    return new Array((value >>> 8), value);
}

function writeInt16(value) {
    writeBytes(shortToBytes(value));
}

function writeInt32f(value) {
    writeBytes(intToBytes(value));
}

function writeInt32(value) {
    return comFlags != 0 ? writeVarint(value) : writeInt32f(value);
}

function writeInt32a(values) {
    values.forEach(val => {
        writeInt32(val);
    });
}

function writeWideStr(value) {
    if (value == null || value == "") {
        writeInt32(0);
        return;
    }
    let size = value.length;
    if (comFlags != 0) size *= 2;
    writeInt32(size);
    writeBytes(iconv.encode(value, "utf16be"));
}

function writeString(value) {
    let size = value.length;
    writeInt32(size);
    writeBytes(iconv.encode(value, "utf-8"));
}

function writeFloat(value) {
    let getHex = i => ('00' + i.toString(16)).slice(-2);
    let view = new DataView(new ArrayBuffer(4)),
        result;
    view.setFloat32(0, value);
    result = Array
        .apply(null, {
            length: 4
        })
        .map((_, i) => getHex(view.getUint8(i)))
        .join('');
    writeBytes(hexToBytes(result));
    return;
}

function readInt32a() {
    let arr = [];
    let numVals = readInt32();
    for (let i = 0; i < numVals; ++i)
        arr.push(readInt32());
    return arr;
}

function readInt64f() {
    let result = fileData.slice(filePos.offset, filePos.offset + 8).readUInt32BE();
    filePos.offset += 8;
    return result;
}

function readInt64() {
    return Math.abs((comFlags == 0 ? readInt64f() : readVarint()));
}

function readInt64d() {
    return readInt64() / (comFlags == 0 ? 2 : 1);
}

function slice(size) {
    let result = fileData.slice(filePos.offset, filePos.offset + size);
    filePos.offset += size;
    return result;
}

function sliceString(size) {
    return slice(size).toString().replace(/[^0-9a-z_-]/gi, "");
}

function getString() {
    let size = readInt32();
    if (comFlags != 0) size /= 2;
    return sliceString(size);
}

function getWideString() {
    let strSize = readInt32();
    if (comFlags == 0) strSize *= 2;
    return iconv.decode(slice(strSize), 'utf16be');
}

function getStringEntry() {
    let entry = {};
    entry.Key = readInt32();
    entry.Str = getWideString();
    entry.Index = readInt32();
    return entry;
}

function makeLamsKeyID(tag) {
    let v0 = 0,
        v1 = 0xC8509800;
    for (let i = 32; i > 0; --i) {
        let c = 0x20;
        if ((i - 1) < tag.length)
            c = tag.charAt(i - 1);
        v0 = v0 * 0x1b + c;
    }
    if (tag.length > 32) {
        v1 = 0;
        for (let i = 64; i > 32; --i) {
            let c = 0x20;
            if ((i - 1) < tag.length)
                c = tag.charAt(i - 1);
            v1 = v1 * 0x1b + c;
        }
    }
    return (v0 + v1 * 0xDEADBEEF) & 0xFFFFFFFF;
}

function getFloat() {
    return Float.intBitsToFloat(readInt32f());
}

function getMatrix() {
    let matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let flags = 0xFFFF;
    if (comFlags != 0) flags = readInt16();
    for (let i = 0; i < 16; ++i)
        if (((flags >>> i) & 1) != 0) matrix[i] = getFloat();
    return matrix;
}

function getVector4() {
    let vector4 = [];
    for (let i = 0; i < 4; ++i)
        vector4.push(getFloat());
    return vector4;
}

function getCreationHistory() {
    let creators = [];
    let numCreators = readInt32();
    for (let i = 0; i < numCreators; ++i)
        creators.push(sliceString(20));
    return creators;
}

function getLegacyCreationHistory() {
    let creators = [];
    let numCreators = readInt32();
    for (let i = 0; i < numCreators; ++i)
        creators.push(getWideString());
    return creators;
}

function getUserDetails() {
    let details = {};
    details.Title = getWideString();
    details.Description = getWideString();
    return details;
}

function getResource(skipFlags) {
    let resource = {};
    let hash = 1,
        guid = 2;
    if (revision <= 0x18B) {
        hash = 2;
        guid = 1;
    }
    let flags = 0;
    if (revision > 0x22e && !skipFlags) flags = readInt32();
    let resType = readInt8();
    if (resType != 0) {
        resource.Flags = flags;
        resource.UID = (resType == guid ? readInt32() : slice(20).toString("hex"));
    }
    return resource;
}

function writeResource(value, skipFlags) {
    let hash = 1,
        guid = 2;
    if (revision <= 0x18B) {
        hash = 2;
        guid = 1;
    }
    if (revision > 0x22e && !skipFlags) {
        if (value == null) writeInt32(0);
        else writeInt32(value.Flags);
    }
    if (value != null) {
        if (value.UID != null) {
            if (value.UID.length / 2 == 20) {
                writeInt8(hash);
                writeBytes(hexToBytes(value.UID));
            } else {
                writeInt8(guid);
                writeInt32(value.UID);
            }
        } else if (value.GUID != null) {
            writeInt8(guid);
            writeInt32(value.GUID);
        } else writeInt8(0);
    } else writeInt8(0);
}

function getSlotID() {
    let slotID = {};
    slotID.Type = readInt32();
    slotID.ID = readInt32();
    return slotID;
}

function getLegacySlotID() {
    let slotID = {};
    slotID.Type = readInt32f();
    slotID.ID = readInt32f();
    return slotID;
}

function getSceNpId() {
    let id = {};
    if (revision < 0x234) {
        let size = readInt32();
        let name = sliceString(size);
        id.Name = name;
        id.Padding = readInt8a(20);
    } else {
        let name = sliceString(20);
        let platformType = sliceString(16);
        id.Name = name;
        id.PlatformType = platformType;
    }
    return id;
}

function getSceNpOnlineId() {
    let id = {};
    if (revision < 0x234) {
        let size = readInt32();
        let name = sliceString(size);
        id.Name = name;
        id.Padding = readInt8a(4);
    } else {
        id.Name = sliceString(20);
    }
    return id;
}

function getLabel() {
    let label = {};
    label.Key = readInt32();
    label.Category = readInt32();
    return label;
}

function getCollectable() {
    let collectable = {};
    collectable.Item = getResource(true);
    collectable.Count = readInt32();
    return collectable;
}

function getSerializedStruct(index) {
    let result = null;
    switch (index) {
        case 1:
            result = getCreationHistory();
            break;
        case 2:
            result = getUserDetails();
            break;
        case 3:
            result = getPhotoData();
            break;
        case 4:
            result = getEyeToyData();
            break;
        case 5:
            result = getSceNpId();
            break;
        case 6:
            result = getPhotoUser();
            break;
        case 7:
            result = getLabel();
            break;
        case 8:
            result = getCollectable();
            break;
        case 9:
            result = getSlotID();
            break;
        default:
            break;
    }
    return result;
}

function getReference(refType) {
    let reference = readInt32();
    if (reference == 0) return null;
    if (Object.keys(refIDs).includes(reference.toString())) return refIDs[reference];
    let result = null;
    result = getSerializedStruct(refType);
    refIDs[reference] = result;
    return result;
}

function getArr(optIndex, isRef) {
    let count = readInt32();
    let arr = [];
    for (let i = 0; i < count; i++)
        arr.push(isRef ? getReference(optIndex) : getSerializedStruct(optIndex));
    return arr;
}

function isLBP3() {
    return revision >> 0x10 != 0;
}

function isVita() {
    return branchID == 0x4431 && revision == 0x3e2;
}

function isAfterLBP3Revision(inputRev) {
    if (!isLBP3()) return false;
    if ((revision >> 0x10) > inputRev) return true;
    return false;
}

function isAfterVitaRevision(inputBranchRev) {
    if (!isVita()) return false;
    if (branchRevision > inputBranchRev) return true;
    return false;
}

function getSlot() {
    let slot = {};
    slot.Slot = getSlotID();
    slot.Root = getResource(true);
    if (isAfterLBP3Revision(0x144))
        slot.Adventure = getResource(true);
    slot.Icon = getResource(true);
    slot.Location = getVector4();
    slot.AuthorID = getSceNpOnlineId();
    if (revision >= 0x13b)
        slot.AuthorName = getWideString();
    if (revision >= 0x183)
        slot.TranslationTag = getString();
    slot.Title = getWideString();
    slot.Description = getWideString();
    slot.PrimaryLinkLevel = getSlotID();
    if (revision >= 0x134)
        slot.PrimaryLinkGroup = getSlotID();
    slot.IsLocked = readBool();
    if (revision >= 0x238) {
        slot.Copyable = readBool();
        slot.BackgroundGUID = readInt32();
    }
    if (revision >= 0x333)
        slot.PlanetDecorations = getResource(true);
    if (revision >= 0x1df)
        slot.DeveloperLevelType = readInt32();
    if (revision < 0x36c && 0x1b8 < revision)
        slot.GameProgressionState = readInt32();
    if (revision <= 0x2c3) return slot;
    if (revision > 0x33c)
        slot.AuthorLabels = getArr(7, false);
    if (revision >= 0x2ea)
        slot.RequiredCollectables = getArr(8, false);
    if (revision >= 0x2f4)
        slot.ContainedCollectables = getArr(8, false);
    if (revision < 0x352) return slot;
    slot.IsSubLevel = readBool();
    if (revision < 0x3d0) return slot;
    slot.MinPlayers = readInt8();
    slot.MaxPlayers = readInt8();
    if (isAfterLBP3Revision(0x214))
        slot.EnforceMinMaxPlayers = readBool();
    if (revision >= 0x3d0)
        slot.MoveRecommended = readBool();
    if (revision >= 0x3e9)
        slot.CrossCompatible = readBool();
    slot.ShowOnPlanet = readBool();
    slot.LivesOverride = readInt8();
    if (isVita()) {
        if (isAfterVitaRevision(0x3c)) {
            slot.AcingEnabled = readBool();
            slot.CustomRewardEnabled = readInt32a();
            slot.RewardConditionDescription = new Array(readInt32());
            for (let i = 0; i < slot.RewardConditionDescription.length; ++i)
                slot.RewardConditionDescription[i] = getWideString();
            slot.CustomRewardCondition = readInt32a();
            slot.AmountNeededCustomReward = new Array(readInt32());
            for (let i = 0; i < slot.AmountNeededCustomReward.length; ++i)
                slot.AmountNeededCustomReward[i] = readInt32f();
            slot.CustomRewardDescription = new Array(readInt32());
            for (let i = 0; i < slot.CustomRewardDescription.length; ++i)
                slot.CustomRewardDescription[i] = getWideString();
        }
        if (isAfterVitaRevision(0x5d))
            slot.ContainsCollectabubbles = readBool();
        if (isAfterVitaRevision(0x4b))
            slot.EnforceMinMaxPlayers = readBool();
        if (isAfterVitaRevision(0x4c))
            slot.SameScreenGame = readBool();
        if (isAfterVitaRevision(0x5c)) {
            slot.SizeOfResources = readInt32();
            slot.SizeOfSubLevels = readInt32();
            slot.SubLevels = getArr(9, false);
            slot.SlotList = getResource(true);
        }
        if (isAfterVitaRevision(0x7f))
            slot.VitaRevision = readInt16();
    }
    if (!isLBP3(revision)) return slot;
    if (isAfterLBP3Revision(0x11))
        slot.GameMode = readInt32();
    if (isAfterLBP3Revision(0xd1))
        slot.IsGameKit = readBool();
    if (isAfterLBP3Revision(0x11a)) {
        slot.EntranceName = getWideString();
        slot.OriginalSlotID = getSlotID();
    }
    if (isAfterLBP3Revision(0x152))
        slot.CustomBadgeSize = readInt8();
    if (isAfterLBP3Revision(0x191)) {
        slot.LocalPath = getString();
        if (isAfterLBP3Revision(0x205))
            slot.ThumbPath = getString();
    }
    return slot;
}

function getPhotoUser() {
    let user = {};
    user.PSID = sliceString(20);
    user.UserName = getWideString();
    user.FrameBounds = getVector4();
    return user;
}

function getPhotoMetadata() {
    let metadata = {};
    metadata.Photo = getResource(true);
    metadata.Level = getSlotID();
    metadata.LevelName = getWideString();
    metadata.LevelHash = slice(20).toString("hex");
    metadata.TimeStamp = readInt64d();
    metadata.Users = getArr(6, false);
    return metadata;
}

function getPhotoData() {
    let data = {};
    data.Icon = getResource(true);
    data.Sticker = getResource(true);
    data.Metadata = getPhotoMetadata();
    if (revision > 0x395) data.Painting = getResource(true);
    return data;
}

function getColorCorrection() {
    let color = [];
    for (let i = 0; i < 6; ++i)
        color.push(getFloat());
    return color;
}

function getEyeToyData() {
    let data = [];
    data.push(getResource(false));
    data.push(getResource(false));
    data.push(getMatrix());
    data.push(getColorCorrection());
    if (revision > 0x2c3) data.push(getResource(false));
    return data;
}

function getFileExt(value) {
    return value.split(".").pop();
}

function removeFileExt(value) {
    return value.replace(/\.[^/.]+$/, "");
}

function decompress(data) {
    let offset = 12;
    let type = data.slice(offset, offset + 2).readInt16BE();
    offset += 2;
    offset += type == 256 ? 1 : 6;
    let streamCount = data.slice(offset, offset + 2).readInt16BE();
    offset += 2;
    let decompressed = new Array(streamCount);
    let compressed = new Array(streamCount);
    let decompressedSize = 0;
    for (let i = 0; i < streamCount; ++i) {
        compressed[i] = Math.abs(data.slice(offset, offset + 2).readInt16BE());
        offset += 2;
        decompressed[i] = Math.abs(data.slice(offset, offset + 2).readInt16BE());
        offset += 2;
        decompressedSize += decompressed[i];
    }
    let output = [];
    for (let i = 0; i < streamCount; ++i) {
        let tempData = data.slice(offset, offset + compressed[i]);
        offset += compressed[i];
        let buffer = zlib.inflateSync(tempData);
        output.push(buffer);
    }
    let result = Buffer.concat(output);
    fs.writeFileSync(`./${removeFileExt(FILENAME)}_dec.${fileExt}`, result);
    return result;
}

function getInventoryDetails(obj) {
    let item = {};
    if (revision > 0x377) {
        item.TimeStamp = readInt64d();
        item.Slot = getSlotID();
        item.HighlightSound = readInt32();
        item.Color = readInt32();
        item.Type = readInt32();
        item.SubType = readInt32();
        item.Title = readInt32();
        item.Description = readInt32();
        item.CreationHistory = getReference(1);
        item.Icon = getResource(true);
        item.UserDetails = getReference(2);
        item.PhotoData = getReference(3);
        item.EyeToyData = getReference(4);
        item.LocationIndex = readInt16();
        item.CategoryIndex = readInt16();
        item.PrimaryIndex = readInt16();
        item.Creator = getReference(5);
        item.ToolType = readInt8();
        item.MiscFlags = readInt8();
    } else {
        let translationTag;
        if (revision > 0x233) {
            item.HighlightSound = readInt32f();
            item.Slot = getLegacySlotID();
        } else translationTag = getString();
        item.LocationIndex = readInt32f();
        item.CategoryIndex = readInt32f();
        item.PrimaryIndex = readInt32f();
        if (revision > 0x233) {
            item.LastUsed = readInt32f();
            item.NumUses = readInt32f();
            item.TagVal1 = readInt32f();
        } else {
            item.TagVal2 = readInt32f();
            item.Type = readInt32f();
            item.SubType = readInt32f();
            if (revision > 0x196) {
                item.ToolType = readInt32f() & 0xFF;
                item.Icon = getResource(true);
            }
        }
        if (revision > 0x233) {
            item.TagVal3 = readInt32f();
            item.TimeStamp = readInt32f();
            item.FluffCost = readInt32f();
        } else if (revision > 0x1c0) {
            item.NumUses = readInt32f();
            item.LastUsed = readInt32f();
        }
        if (revision > 0x14e) {
            if (revision > 0x233) {
                item.Color = readInt32f();
                item.Type = readInt32f();
                item.SubType = readInt32f();
                item.ToolType = readInt32f() & 0xFF;
            } else {
                item.HighlightSound = readInt32f();
                if (revision > 0x156) {
                    item.Color = readInt32f();
                    item.EyeToyData = getReference(4);
                }
                if (revision > 0x176) {
                    if (revision > 0x181)
                        item.PhotoData = getReference(3);
                    item.Slot = getLegacySlotID();
                }
                if (revision > 0x181) item.Copyright = readInt8();
            }
        }
        if (revision > 0x181)
            item.Creator = getSceNpId();
        if (revision > 0x233) {
            item.AllowEmit = readInt8();
            item.Shareable = readInt8();
            item.Copyright = readInt8();
            if (revision >= 0x336) item.TagVal4 = readInt8();
        }
        if ((revision == 0x272 && branchID != 0) || revision > 0x2ba) {
            item.Title = readInt32();
            item.Description = readInt32();
        } else if (revision > 0x233) translationTag = getString();
        item.TranslationTag = translationTag;
        if (translationTag != "") {
            item.Title = makeLamsKeyID(translationTag + "_NAME");
            item.Description = makeLamsKeyID(translationTag + "_DESC");
        }
        if (revision > 0x1aa) {
            item.UserDetails = getUserDetails();
            if (revision > 0x1b0) {
                item.CreationHistory = getLegacyCreationHistory();
            }
        }
        if (revision > 0x233) {
            item.Icon = getResource(true);
            item.PhotoData = getReference(3);
            item.EyeToyData = getReference(4);
        } else if (revision > 0x204) {
            item.AllowEmit = readInt8();
            if (revision > 0x221) {
                item.TagVal5 = readInt32f();
                item.TimeStamp = readInt32f();
            }
        }
    }
    obj.Details = item;
}

function toUint8Array(v, includeLength) {
    var length = v.length;
    var n = length << 2;
    if (includeLength) {
        var m = v[length - 1];
        n -= 4;
        if ((m < n - 3) || (m > n)) {
            return null;
        }
        n = m;
    }
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; ++i) {
        bytes[i] = v[i >> 2] >> ((i & 3) << 3);
    }
    return bytes;
}

function toUint32Array(bytes, includeLength) {
    var length = bytes.length;
    var n = length >> 2;
    if ((length & 3) !== 0) {
        ++n;
    }
    var v;
    if (includeLength) {
        v = new Uint32Array(n + 1);
        v[n] = length;
    }
    else {
        v = new Uint32Array(n);
    }
    for (var i = 0; i < length; ++i) {
        v[i >> 2] |= bytes[i] << ((i & 3) << 3);
    }
    return v;
}

function mx(sum, y, z, p, e, k) {
    return ((z >>> 5 ^ y << 2) + (y >>> 3 ^ z << 4)) ^ ((sum ^ y) + (k[p & 3 ^ e] ^ z));
}

function decryptUint32Array(v, k) {
    var length = v.length;
    var n = length - 1;
    var y, z, sum, e, p, q;
	var delta = 0x9E3779B9;
    y = v[0];
    q = Math.floor(6 + 52 / length);
    for (sum = q * delta; sum !== 0; sum -= delta) {
        e = sum >>> 2 & 3;
        for (p = n; p > 0; --p) {
            z = v[p - 1];
            y = v[p] -= mx(sum, y, z, p, e, k);
        }
        z = v[n];
        y = v[0] -= mx(sum, y, z, p, e, k);
    }
    return v;
}

function BPRIPRtoJSON() {
    try {
        fileData = fs.readFileSync(`${ROOT_DIR}/${FILENAME}`);
    } catch {
        console.log("The profile could not be found or read.");
        return;
    }
    filePos.offset = fileData.length - 4;
    let archiveMagic = sliceString(4);
    if (archiveMagic != "FAR4" && archiveMagic != "FAR5") {
        console.log("Not a valid profile.");
        return;
    }
	let magicStrings = ["BPRb", "IPRb", "IPRe"];
	let magicStr, magicIndex, isEncrypted;
	for (let i = 0; i < magicStrings.length; ++i) {
		magicStr = magicStrings[i].slice(0, -1);
		magicIndex = fileData.indexOf(magicStrings[i]);
		if (magicIndex != -1) {
			if (magicStrings[i] == "IPRe") isEncrypted = true;
			break;
		}
		else if (i == magicStrings.length - 1) {
			console.log("The profile contains no metadata.");
			return;
		}
	}
    filePos.offset = magicIndex + 4;
    revision = readInt32f();
    let depTableOff = readInt32f();
    branchID = readInt16();
    branchRevision = readInt16();
    if (!(revision == 0x272 || revision > 0x297)) comFlags = 0;
	if (isEncrypted) {
		let key = [28773565, 345376726, 133778901, 282823840];
		readInt16();
		let encryptedSize = readInt32f();
		let padding = 0;
		if (encryptedSize % 4 != 0) padding = 4 - (encryptedSize % 4);
		let encryptedBlockLen = filePos.offset + encryptedSize + padding;
		let encrypted = fileData.slice(filePos.offset, encryptedBlockLen).swap32();
		let decrypted = Buffer.from(toUint8Array(decryptUint32Array(toUint32Array(encrypted, false), key), false)).swap32().slice(1);
		depTableOff = encryptedBlockLen - 5;
		let depTableOffBuf = Buffer.alloc(4);
		depTableOffBuf.writeUInt32BE(depTableOff);
		fileData = Buffer.concat([Buffer.from("IPRb"), fileData.slice(4, 8), depTableOffBuf, fileData.slice(12, 18), decrypted, fileData.slice(encryptedBlockLen)]);
	}
	filePos.offset = depTableOff;
    let depTableCount = readInt32f();
    for (let i = 0; i < depTableCount; ++i) {
        if (i != 0) filePos.offset += 4;
        let dataType = readInt8();
        filePos.offset += (dataType == 2 ? 4 : 20);
    }
    filePos.offset += 4;
	fileExt = magicStr.toLowerCase();
    fileData = decompress(fileData.slice(magicIndex, filePos.offset));
    if (fileData.length == 0) {
        console.log("The profile is empty.");
        return;
    }
    filePos.offset = 0;
    let itemCount = readInt32();
    let profile = {};
    profile.RType = magicStr;
    profile.Items = {};
    profile.Revision = revision;
    profile.ComFlags = comFlags;
    profile.BranchID = branchID;
    profile.BranchRev = branchRevision;
    for (let i = 0; i < itemCount; ++i) {
        let item = {};
        item.Resource = getResource(true);
        if (revision > 0x010503EF) item.GUID = readInt32();
        getInventoryDetails(item);
        if (revision == 0x3e2) item.StartingFlags = readInt8();
        filePos.offset += 2;
        item.Index = readInt16();
        filePos.offset += 3;
        let itemFlags = readInt8();
        if (revision > 0x33a) {
            filePos.offset += 3;
            item.EndingFlags = readInt8();
        } else {
            filePos.offset += 3;
            item.EndingFlags = readInt8();
            filePos.offset += 3;
            itemFlags = readInt8();
        }
        item.ItemFlags = itemFlags;
        profile.Items[i + 1] = item;
    }
    if (revision >= 0x3e6) {
        let hashes = {};
		console.log(filePos.offset);
        let hashCount = readInt32();
        for (let i = 0; i < hashCount; ++i) {
            let hash = slice(20);
            hashes[i + 1] = hash;
        }
        profile.Hashes = hashes;
    }
    if (revision >= 0x3f6 && revision != 0x3e2) {
        let labels = {};
        let labelCount = readInt32();
        for (let i = 0; i < labelCount; ++i) {
            let label = {};
            label.Key = readInt32();
            label.Str = getWideString();
            labels[i + 1] = label;
        }
        profile.Labels = labels;
    }
    profile.Unsorted = readBool();
    profile.SortEnabled = readBool();
    let stringCount = readInt32();
    if (stringCount != 0) {
        let tableCount = readInt8();
        let tables = {};
        for (let i = 0; i < tableCount; ++i) {
            let table = [];
            for (let j = 0; j < stringCount; ++j) {
                table.push(readInt8());
            }
            tables[i + 1] = table;
        }
        profile.Tables = tables;
    }
    stringCount = readInt32();
    let strings = {};
	// PRELIMINARY RETURN TO PREVENT EXCEPTIONS
	return;
    for (let i = 0; i < stringCount; ++i) {
        strings[i + 1] = getStringEntry();
        nextIndex++;
    }
    profile.Strings = strings;
    let fromProductionBuild;
    if (revision > 0x33a) fromProductionBuild = readBool();
    profile.FromProduction = fromProductionBuild;
    let slotCount = readInt32();
    let slots = {};
    for (let i = 0; i < slotCount; ++i) {
        getSlotID();
        let slot = getSlot();
        slots[i + 1] = slot;
    }
    profile.Slots = slots;
    if (revision == 0x3e2) {
        let labelCount = readInt32();
        let labels = {};
        for (let i = 0; i < labelCount; ++i) {
            let label = [];
            label.Key = readInt32();
            label.Str = getWideString();
            labels[i + 1] = label;
        }
        profile.Labels = labels;
        let unknownVals = [];
        for (let i = 0; i < 3; ++i)
            unknownVals.push(readInt32());
        profile.UnknownValues = unknownVals;
        let numSlots = readInt32();
        profile.NumSlots = numSlots;
        let downloadedSlots = [];
        for (let i = 0; i < numSlots; ++i)
            downloadedSlots.push(getSlotID());
        profile.DownloadedSlots = downloadedSlots;
        profile.Planets = getResource(true);
    }
    fs.writeFileSync(`./${FILENAME}.json`, JSON.stringify(profile, null, 2));
}

function hexToBytes(hex) {
    for (var bytes = [], c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
    return bytes;
}

function findRefObj(obj) {
    return refObjs.findIndex(x => JSON.stringify(x) == JSON.stringify(obj));
}

function writePhotoData(item) {
    try {
        let photoData = Object.entries(item.PhotoData);
        reference++;
        writeInt32(reference);
        let data = item.PhotoData;
        let metadata = data.Metadata;
        writeResource(data.Icon, true);
        writeResource(data.Sticker, true);
        writeResource(metadata.Photo, true);
        let slotID = metadata.Level;
        writeInt32(slotID.Type);
        writeInt32(slotID.ID);
        writeWideStr(metadata.LevelName);
        writeBytes(hexToBytes(metadata.LevelHash));
        writeInt32(metadata.TimeStamp);
        let users = Object.entries(item.PhotoData.Metadata.Users);
        writeInt32(users.length);
        users.forEach(user => {
            writeBytes(iconv.encode(user[1].PSID.padEnd(20, "\u0000"), "utf-8"));
            writeInt32(user[1].UserName.length * 2);
            writeBytes(iconv.encode(user[1].UserName, "utf16be"));
            let bounds = user[1].FrameBounds;
            bounds.forEach(val => {
                writeFloat(val);
            });
        });
        if (revision > 0x395) writeResource(item.PhotoData.Painting, true);
        refObjs.push(item.PhotoData);
    } catch {
        writeInt32(0);
    }
}

function writeCreator(item, isRef) {
    try {
        let creator = Object.entries(item.Creator);
        let name = item.Creator.Name;
        let type = item.Creator.PlatformType;
        let objIndex = findRefObj(item.Creator);
        if (objIndex == -1) {
            if (isRef) {
                reference++;
                writeInt32(reference);
            }
            if (revision < 0x234) {
                writeInt32(name.length);
                writeBytes(name, "utf-8");
                writeInt8a(item.Creator.Padding);
            } else {
                writeBytes(iconv.encode(name.padEnd(20, "\u0000"), "utf-8"));
                writeBytes(iconv.encode(type.padEnd(16, "\u0000").replace(/./g, (c, i) => (i == 8 && type != "" ? "\u0001" : c)), "utf-8"));
            }
            if (isRef) refObjs.push(item.Creator);
        } else {
            writeInt32(objIndex);
        }
    } catch {
        writeInt32(0);
    }
}

function writeDetails(item, isRef) {
    try {
        let details = Object.entries(item.UserDetails);
        let objIndex = findRefObj(item.UserDetails);
        if (objIndex == -1) {
            if (isRef) {
                reference++;
                writeInt32(reference);
            }
            details.forEach(entry => {
                writeWideStr(entry[1]);
            });
            if (isRef) refObjs.push(item.UserDetails);
        } else {
            writeInt32(objIndex);
        }
    } catch {
        writeInt32(0);
    }
}

function writeCreationHistory(item, isLegacy, isRef) {
    try {
        let creators = Object.entries(item.CreationHistory);
        let objIndex = findRefObj(item.CreationHistory);
        if (objIndex == -1) {
            if (isRef) {
                reference++;
                writeInt32(reference);
            }
            writeInt32(creators.length);
            creators.forEach(creator => {
                if (isLegacy) {
                    writeInt32(creator[1].length * 2);
                    writeBytes(iconv.encode(creator[1], "utf16be"));
                } else {
                    writeBytes(iconv.encode(creator[1].padEnd(20, "\u0000"), "utf-8"));
                }
            });
            if (isRef) refObjs.push(item.CreationHistory);
        } else {
            writeInt32(objIndex);
        }
    } catch {
        writeInt32(0);
    }
}

function writeInventoryDetails(item) {
    if (revision > 0x377) {
        writeInt32(item.TimeStamp);
        writeInt32(item.Slot.Type);
        writeInt32(item.Slot.ID);
        writeInt32(item.HighlightSound);
        writeInt32(item.Color);
        writeInt32(item.Type);
        writeInt32(item.SubType);
        writeInt32(item.Title);
        writeInt32(item.Description);
        writeCreationHistory(item, false, true);
        writeResource(item.Icon, true);
        writeDetails(item, true);
        writePhotoData(item);
        // write eyetoy data
        writeInt32(0);
        writeInt16(item.LocationIndex);
        writeInt16(item.CategoryIndex);
        writeInt16(item.PrimaryIndex);
        writeCreator(item, true);
        writeInt8(item.ToolType);
        writeInt8(item.MiscFlags);
    } else {
        if (revision > 0x233) {
            writeInt32f(item.HighlightSound);
            writeInt32f(item.Slot.Type);
            writeInt32f(item.Slot.ID);
        } else {
            if (!item.TranslationTag)
                writeInt32(0);
            else {
                writeInt32(item.TranslationTag.length);
                writeBytes(iconv.encode(item.TranslationTag, "utf-8"));
            }
        }
        writeInt32f(item.LocationIndex);
        writeInt32f(item.CategoryIndex);
        writeInt32f(item.PrimaryIndex);
        if (revision > 0x233) {
            writeInt32f(item.LastUsed);
            writeInt32f(item.NumUses);
            writeInt32f(item.TagVal1);
        } else {
            writeInt32f(item.TagVal2);
            writeInt32f(item.Type);
            writeInt32f(item.SubType);
            if (revision > 0x196) {
                writeInt32f(item.ToolType);
                writeResource(item.Icon, true);
            }
        }
        if (revision > 0x233) {
            writeInt32f(item.TagVal3);
            writeInt32f(item.TimeStamp);
            writeInt32f(item.FluffCost);
        } else if (revision > 0x1c0) {
            writeInt32f(item.NumUses);
            writeInt32f(item.LastUsed);
        }
        if (revision > 0x14e) {
            if (revision > 0x233) {
                writeInt32f(item.Color);
                writeInt32f(item.Type);
                writeInt32f(item.SubType);
                writeInt32f(item.ToolType);
            } else {
                writeInt32f(item.HighlightSound);
                if (revision > 0x156) {
                    writeInt32f(item.Color);
                    // write eyetoy data
                    writeInt32f(0);
                }
                if (revision > 0x176) {
                    if (revision > 0x181)
                        writePhotoData(item);
                    writeInt32f(item.Slot.Type);
                    writeInt32f(item.Slot.ID);
                }
                if (revision > 0x181) writeInt8(item.Copyright);
            }
        }
        if (revision > 0x181)
            writeCreator(item, false);
        if (revision > 0x233) {
            writeInt8(item.AllowEmit);
            writeInt8(item.Shareable);
            writeInt8(item.Copyright);
            if (revision >= 0x336) {
                writeInt8(item.TagVal4);
            }
        }
        if ((revision == 0x272 && branchID != 0) || revision > 0x2ba) {
            writeInt32(item.Title);
            writeInt32(item.Description);
        } else if (revision > 0x233) {
            if (!item.TranslationTag)
                writeInt32(0);
            else {
                writeInt32(item.TranslationTag.length);
                writeBytes(iconv.encode(item.TranslationTag, "utf-8"));
            }
        }
        if (revision > 0x1aa) {
            writeDetails(item);
            if (revision > 0x1b0)
                writeCreationHistory(item, true, false);
        }
        if (revision > 0x233) {
            writeResource(item.Icon, true);
            writePhotoData(item);
            // write eyetoy data
            writeInt32(0);
        } else if (revision > 0x204) {
            writeInt8(item.AllowEmit);
            if (revision > 0x221) {
                writeInt32f(item.TagVal5);
                writeInt32f(item.TimeStamp);
            }
        }
    }
}

function writeSlots(slotList, isProfile) {
    try {
        let slots = Object.entries(slotList);
        if (slots.length == 0) throw new Error();
        writeInt32(slots.length);
        for (let i = 0; i < slots.length; ++i) {
            let slot = slots[i][1];
            let count = isProfile ? 2 : 1;
            for (let i = 0; i < count; ++i) {
                writeInt32(slot.Slot.Type);
                writeInt32(slot.Slot.ID);
            }
            writeResource(slot.Root, true);
            if (isAfterLBP3Revision(0x144))
                writeResource(slot.Adventure, true);
            writeResource(slot.Icon, true);
            let loc = slot.Location;
            loc.forEach(val => {
                writeFloat(val);
            });
            let name = slot.AuthorID.Name;
            if (revision < 0x234) {
                writeInt32(name.length);
                writeBytes(iconv.encode(name, "utf-8"));
                writeInt8a(slot.AuthorID.Padding);
            } else {
                writeBytes(iconv.encode(name.padEnd(20, "\u0000"), "utf-8"));
            }
            if (revision >= 0x13b)
                writeWideStr(slot.AuthorName);
            if (revision >= 0x183) {
                let translationTag = slot.TranslationTag;
                writeInt32(translationTag.length * (comFlags == 0 ? 1 : 2));
                writeBytes(iconv.encode(translationTag, "utf-8"));
            }
            writeWideStr(slot.Title);
            writeWideStr(slot.Description);
            writeInt32(slot.PrimaryLinkLevel.Type);
            writeInt32(slot.PrimaryLinkLevel.ID);
            if (revision >= 0x134) {
                writeInt32(slot.PrimaryLinkGroup.Type);
                writeInt32(slot.PrimaryLinkGroup.ID);
            }
            writeBool(slot.IsLocked);
            if (revision >= 0x238) {
                writeBool(slot.Copyable);
                writeInt32(slot.BackgroundGUID);
            }
            if (revision >= 0x333)
                writeResource(slot.PlanetDecorations, true);
            if (revision >= 0x1df)
                writeInt8(slot.DeveloperLevelType);
            if (revision < 0x36c && 0x1b8 < revision)
                writeInt32(slot.GameProgressionState);
            // check
            if (comFlags == 0) writeBytes(new Array(0, 0, 0));
            if (revision <= 0x2c3) continue;
            if (revision > 0x33c) {
                try {
                    let authorLabels = Object.entries(slot.AuthorLabels);
                    if (authorLabels.length == 0) throw new Error();
                    writeInt32(authorLabels.length);
                    authorLabels.forEach(label => {
                        writeInt32(label[1].Key);
                        writeInt32(label[1].Category);
                    });
                } catch {
                    writeInt32(0);
                }
            }
            for (let i = 0; i < 2; ++i) {
                let wantsReq = i == 0 && revision >= 0x2ea;
                let wantsContained = i == 1 && revision >= 0x2f4;
                try {
                    let collectables = null;
                    if (wantsReq)
                        collectables = Object.entries(slot.RequiredCollectables)
                    else if (wantsContained)
                        collectables = Object.entries(slot.ContainedCollectables);
                    else continue;
                    if (collectables.length == 0) throw new Error();
                    writeInt32(collectables.length);
                    collectables.forEach(col => {
                        writeResource(col[1].Item, true);
                        writeInt32(col[1].Count);
                    });
                } catch {
                    writeInt32(0);
                }
            }
            if (revision < 0x352) continue;
            writeBool(slot.IsSubLevel);
            if (revision < 0x3d0) continue;
            writeInt8(slot.MinPlayers);
            writeInt8(slot.MaxPlayers);
            if (isAfterLBP3Revision(0x214))
                writeBool(slot.EnforceMinMaxPlayers);
            if (revision >= 0x3d0)
                writeBool(slot.MoveRecommended);
            if (revision >= 0x3e9)
                writeBool(slot.CrossCompatible);
            writeBool(slot.ShowOnPlanet);
            writeInt8(slot.LivesOverride);
            if (isVita()) {
                if (isAfterVitaRevision(0x3c)) {
                    writeBool(slot.AcingEnabled);
                    writeInt32(slot.CustomRewardEnabled.length);
                    writeInt32a(slot.CustomRewardEnabled);
                    writeInt32(slot.RewardConditionDescription.length);
                    slot.RewardConditionDescription.forEach(val => {
                        writeWideStr(val);
                    });
                    writeInt32(slot.CustomRewardCondition.length);
                    writeInt32a(slot.CustomRewardCondition);
                    writeInt32(slot.AmountNeededCustomReward.length);
                    slot.AmountNeededCustomReward.forEach(val => {
                        writeInt32f(val);
                    });
                    writeInt32(slot.CustomRewardDescription.length);
                    slot.CustomRewardDescription.forEach(val => {
                        writeWideStr(val);
                    });
                }
                if (isAfterVitaRevision(0x5d))
                    writeBool(slot.ContainsCollectabubbles);
                if (isAfterVitaRevision(0x4b))
                    writeBool(slot.EnforceMinMaxPlayers);
                if (isAfterVitaRevision(0x4c))
                    writeBool(slot.SameScreenGame);
                if (isAfterVitaRevision(0x5c)) {
                    writeInt32(slot.SizeOfResources);
                    writeInt32(slot.SizeOfSubLevels);
                    writeInt32(slot.SubLevels.length);
                    slot.SubLevels.forEach(entry => {
                        writeInt32(entry.Type);
                        writeInt32(entry.ID);
                    });
                    writeResource(slot.SlotList);
                }
                if (isAfterVitaRevision(0x7f))
                    writeInt16(slot.VitaRevision);
            }
            if (!isLBP3(revision)) continue;
            if (isAfterLBP3Revision(0x11))
                writeInt32(slot.GameMode);
            if (isAfterLBP3Revision(0xd1))
                writeInt32(slot.IsGameKit);
            if (isAfterLBP3Revision(0x11a)) {
                writeWideStr(slot.EntranceName);
                writeInt32(slot.OriginalSlotID.Type);
                writeInt32(slot.OriginalSlotID.ID);
            }
            if (isAfterLBP3Revision(0x152))
                writeInt8(slot.CustomBadgeSize);
            if (isAfterLBP3Revision(0x191)) {
                writeInt32(slot.LocalPath.length);
                writeBytes(iconv.encode(slot.LocalPath, "utf-8"));
                if (isAfterLBP3Revision(0x205)) {
                    writeInt32(slot.ThumbPath.length);
                    writeBytes(iconv.encode(slot.ThumbPath, "utf-8"));
                }
            }
        }
    } catch {
        writeInt32(0);
    }
}

function JSONtoBPRIPR() {
    try {
        profile = JSON.parse(fs.readFileSync(`${ROOT_DIR}/${FILENAME}`));
    } catch {
        console.log("The profile JSON could not be found or read.");
        return;
    }
    filePos.offset = 0;
    revision = profile.Revision;
    comFlags = profile.ComFlags;
    branchID = profile.BranchID;
    branchRevision = profile.BranchRev;
    let items = Object.entries(profile.Items);
    let itemCount = items.length;
    writeInt32(itemCount);
    for (let i = 0; i < itemCount; ++i) {
        let item = items[i][1];
        writeResource(item.Resource, true);
        if (revision > 0x010503EF) writeInt32(item.GUID);
        writeInventoryDetails(item.Details);
        if (revision == 0x3e2) writeInt8(item.StartingFlags);
		// For IPR, it appears we write a 0 instead of 128
        writeInt8(128);
        writeInt32(0);
        writeInt16(item.Index);
        writeBytes(new Array(0, 0, 0));
        if (revision > 0x33a) {
            writeInt8(item.ItemFlags);
            writeBytes(new Array(0, 0, 0, item.EndingFlags));
        } else {
            writeBytes(new Array(0, 0, 0, 0, 0, 0, 0, item.EndingFlags));
            writeInt8(item.ItemFlags);
        }
    }
    if (revision >= 0x3e6) {
        try {
            let hashes = Object.entries(profile.Hashes);
            if (hashes.length == 0) throw new Error();
            writeInt32(hashes.length);
            hashes.forEach(hash => {
                writeBytes(hexToBytes(hash[1]));
            });
        } catch {
            writeInt32(0);
        }
    }
    if (revision >= 0x3f6 && revision != 0x3e2) {
        try {
            let labels = Object.entries(profile.Labels);
            if (labels.length == 0) throw new Error();
            writeInt32(labels.length);
            labels.forEach(entry => {
                let label = entry[1];
                writeInt32(label.Key);
                writeWideStr(label.Str);
            });
        } catch {
            writeInt32(0);
        }
    }
    writeBool(profile.Unsorted);
    writeBool(profile.SortEnabled);
    let strings = [];
    try {
        strings = Object.entries(profile.Strings);
        if (strings.length == 0) throw new Error();
        writeInt32(strings.length);
    } catch {
        writeInt32(0);
    }
    try {
        let tables = Object.entries(profile.Tables);
        if (tables.length == 0) throw new Error();
        writeInt8(tables.length);
        tables.forEach(entry => {
            let table = Object.entries(entry[1]);
            table.forEach(val => {
                writeInt8(val[1]);
            });
        });
    } catch {
        writeInt32(0);
    }
    try {
        writeInt32(strings.length);
        strings.forEach(entry => {
            writeInt32(entry[1].Key);
            writeWideStr(entry[1].Str);
            writeInt32(entry[1].Index);
        });
    } catch {
        writeInt32(0);
    }
    if (revision > 0x33a) writeBool(profile.FromProduction);
    writeSlots(profile.Slots, true);
    if (revision == 0x3e2) {
        try {
            let labels = Object.entries(profile.Labels);
            if (labels.length == 0) throw new Error();
            labels.forEach(entry => {
                writeInt32(entry[1].Key);
                writeWideStr(entry[1].Str);
            });
        } catch {
            writeInt32(0);
        }
        try {
            let unknownVals = Object.entries(profile.UnknownValues);
            if (unknownVals.length == 0) throw new Error();
            for (let i = 0; i < 3; ++i)
                writeInt32(unknownVals[i][1]);
        } catch {
            writeInt32(0);
        }
        writeInt32(profile.NumSlots);
        try {
            let downloadedSlots = Object.entries(profile.DownloadedSlots);
            if (downloadedSlots.length == 0) throw new Error();
            downloadedSlots.forEach(slot => {
                writeInt32(slot[1].Type);
                writeInt32(slot[1].ID);
            });
        } catch {}
        writeResource(profile.Planets, true);
    }
	// IPR appears to add extra padding at EOF, need to investigate
    fs.writeFileSync(`./${FILENAME.replace(".json", "")}_o.${profile.RType.toLowerCase()}`, Buffer.from(output));
}

function printRootLevelInfo(plan) {
	try {
		let metadata = plan.Details.PhotoData.Metadata;
		if (plan.Details.Type == 1032) {
			console.log(`${metadata.LevelName} by ${plan.Details.Creator.Name}`);
			console.log(`${metadata.LevelHash} => ${metadata.Level.ID}`);
		}
	} catch {
		return;
	}
}

function PLANtoJSON() {
    try {
        fileData = fs.readFileSync(`${ROOT_DIR}/${FILENAME}`);
    } catch {
        console.log("The PLAN file could not be found or read.");
        return;
    }
    let plan = {};
    filePos.offset = 12;
    branchID = readInt16();
    plan.BranchID = branchID;
	branchRevision = readInt16();
	plan.BranchRev = branchRevision;
	if (!(revision == 0x272 || revision > 0x297)) comFlags = 0;
	fileData = decompress(fileData);
    filePos.offset = 0;
    plan.RType = "PLAN";
    revision = readInt32();
    plan.Revision = revision;
    if (revision >= 0x00D003E7) {
        forStreaming = readBool();
        plan.ForStreaming = forStreaming;
    }
    plan.ThingData = readInt8a(readInt32());
    if (filePos.offset != fileData.length) {
        if (revision >= 0x197) {
            getInventoryDetails(plan);
			printRootLevelInfo(plan);
            if ((revision == 0x272 && branchID != 0) || revision > 0x2ba) {
                plan.LocationKey = readInt32();
                plan.CategoryKey = readInt32();
            } else {
                plan.LocationTag = getString();
                plan.CategoryTag = getString();
                plan.Location = makeLamsKeyID(plan.LocationTag);
                plan.Category = makeLamsKeyID(plan.CategoryTag);
            }
        }
    }
    fs.writeFileSync(`./${FILENAME.replace(".plan", ".json")}`, JSON.stringify(plan, null, 2));
}

function JSONtoPLAN() {
    try {
        plan = JSON.parse(fs.readFileSync(`${ROOT_DIR}/${FILENAME}`));
    } catch {
        console.log("The plan JSON could not be found or read.");
        return;
    }
    filePos.offset = 0;
    branchID = plan.BranchID;
    revision = plan.Revision;
	if (!(revision == 0x272 || revision > 0x297)) comFlags = 0;
    writeInt32(revision);
    if (revision >= 0x00D003E7) writeBool(plan.ForStreaming);
    writeInt32(plan.ThingData.length);
    writeInt8a(plan.ThingData);
    if (revision >= 0x197) {
        writeInventoryDetails(plan.Details);
		printRootLevelInfo(plan);
        if ((revision == 0x272 && branchID != 0) || revision > 0x2ba) {
            writeInt32(plan.LocationKey);
            writeInt32(plan.CategoryKey);
        } else {
            writeString(plan.LocationTag);
            writeString(plan.CategoryTag);
        }
    }
    fs.writeFileSync(`./${removeFileExt(FILENAME)}_o.plan`, Buffer.from(output));
}

function SLTtoJSON() {
    try {
        fileData = fs.readFileSync(`${ROOT_DIR}/${FILENAME}`);
    } catch {
        console.log("The SLT file could not be found or read.");
        return;
    }
    let slotList = {};
    filePos.offset = 4;
    revision = readInt32f();
    slotList.Revision = revision;
    filePos.offset = 12;
    branchID = readInt16();
    slotList.BranchID = branchID;
    branchRevision = readInt16();
    slotList.BranchRev = branchRevision;
    if (!(revision == 0x272 || revision > 0x297)) comFlags = 0;
    slotList.ComFlags = comFlags;
    fileData = decompress(fileData);
    filePos.offset = 0;
    slotList.RType = "SLT";
    let numSlots = readInt32();
    let slots = {};
    for (let i = 0; i < numSlots; ++i)
        slots[i + 1] = getSlot();
    slotList.Slots = slots;
    fs.writeFileSync(`./${FILENAME.replace(".slt", ".json")}`, JSON.stringify(slotList, null, 2));
}

function JSONtoSLT() {
    try {
        slotList = JSON.parse(fs.readFileSync(`${ROOT_DIR}/${FILENAME}`));
    } catch {
        console.log("The slot JSON could not be found or read.");
        return;
    }
    filePos.offset = 0;
    branchID = slotList.BranchID;
    branchRevision = slotList.BranchRev;
    revision = slotList.Revision;
    comFlags = slotList.ComFlags;
    writeSlots(slotList.Slots, false);
    fs.writeFileSync(`./${removeFileExt(FILENAME)}_o.slt`, Buffer.from(output));
}

fileExt = getFileExt(FILENAME);
switch (fileExt) {
    case "json":
        let resource = JSON.parse(fs.readFileSync(`${ROOT_DIR}/${FILENAME}`));
        if (resource.RType == "PLAN") {
            JSONtoPLAN();
        } else if (resource.RType == "BPR" || resource.RType == "IPR") {
            JSONtoBPRIPR();
        } else if (resource.RType == "SLT") {
            JSONtoSLT();
        }
        break;
    case "plan":
        PLANtoJSON();
        break;
    case "slt":
        SLTtoJSON();
        break;
    default:
        BPRIPRtoJSON();
        break;
}