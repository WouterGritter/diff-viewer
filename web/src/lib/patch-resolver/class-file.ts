/**
 * Just enough JVM class file parsing to discover which classes a class references, plus a
 * generator for stub classes that reference an arbitrary set of classes. Used to widen the
 * set of classes the WASM Vineflower port preloads (its dependency analyzer only inspects the
 * constant pools of the classes being decompiled).
 */

export interface ClassInfo {
  name: string;
  superName: string | null;
  interfaces: string[];
  /** All class names referenced by the constant pool (CONSTANT_Class entries and descriptors) */
  references: Set<string>;
}

const CONSTANT_Utf8 = 1;
const CONSTANT_Integer = 3;
const CONSTANT_Float = 4;
const CONSTANT_Long = 5;
const CONSTANT_Double = 6;
const CONSTANT_Class = 7;
const CONSTANT_String = 8;
const CONSTANT_Fieldref = 9;
const CONSTANT_Methodref = 10;
const CONSTANT_InterfaceMethodref = 11;
const CONSTANT_NameAndType = 12;
const CONSTANT_MethodHandle = 15;
const CONSTANT_MethodType = 16;
const CONSTANT_Dynamic = 17;
const CONSTANT_InvokeDynamic = 18;
const CONSTANT_Module = 19;
const CONSTANT_Package = 20;

function addDescriptorTypes(descriptor: string, into: Set<string>) {
  let i = 0;
  while (i < descriptor.length) {
    const c = descriptor.charAt(i);
    if (c === "L") {
      const end = descriptor.indexOf(";", i);
      if (end === -1) return;
      into.add(descriptor.substring(i + 1, end));
      i = end + 1;
    } else {
      i++;
    }
  }
}

export function parseClassFile(bytes: Uint8Array): ClassInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0xcafebabe) throw new Error("Not a class file");
  const decoder = new TextDecoder();

  const cpCount = view.getUint16(8);
  const utf8: (string | undefined)[] = new Array(cpCount);
  const classNameIndex: (number | undefined)[] = new Array(cpCount);
  const nameAndTypeDescIndex: (number | undefined)[] = new Array(cpCount);
  const methodTypeDescIndex: (number | undefined)[] = new Array(cpCount);

  let pos = 10;
  for (let i = 1; i < cpCount; i++) {
    const tag = view.getUint8(pos);
    pos++;
    switch (tag) {
      case CONSTANT_Utf8: {
        const length = view.getUint16(pos);
        utf8[i] = decoder.decode(bytes.subarray(pos + 2, pos + 2 + length));
        pos += 2 + length;
        break;
      }
      case CONSTANT_Integer:
      case CONSTANT_Float:
        pos += 4;
        break;
      case CONSTANT_Long:
      case CONSTANT_Double:
        pos += 8;
        i++; // takes two slots
        break;
      case CONSTANT_Class:
        classNameIndex[i] = view.getUint16(pos);
        pos += 2;
        break;
      case CONSTANT_String:
      case CONSTANT_Module:
      case CONSTANT_Package:
        pos += 2;
        break;
      case CONSTANT_Fieldref:
      case CONSTANT_Methodref:
      case CONSTANT_InterfaceMethodref:
      case CONSTANT_Dynamic:
      case CONSTANT_InvokeDynamic:
        pos += 4;
        break;
      case CONSTANT_NameAndType:
        nameAndTypeDescIndex[i] = view.getUint16(pos + 2);
        pos += 4;
        break;
      case CONSTANT_MethodHandle:
        pos += 3;
        break;
      case CONSTANT_MethodType:
        methodTypeDescIndex[i] = view.getUint16(pos);
        pos += 2;
        break;
      default:
        throw new Error(`Unknown constant pool tag ${tag}`);
    }
  }

  const references = new Set<string>();
  const className = (index: number | undefined): string | null => {
    if (index === undefined) return null;
    const name = utf8[classNameIndex[index]!];
    return name ?? null;
  };
  for (let i = 1; i < cpCount; i++) {
    const cni = classNameIndex[i];
    if (cni !== undefined) {
      const name = utf8[cni];
      if (name !== undefined) {
        if (name.startsWith("[")) addDescriptorTypes(name, references);
        else references.add(name);
      }
    }
    const desc = nameAndTypeDescIndex[i] ?? methodTypeDescIndex[i];
    if (desc !== undefined) {
      const d = utf8[desc];
      if (d !== undefined) addDescriptorTypes(d, references);
    }
  }

  pos += 2; // access flags
  const thisClass = className(view.getUint16(pos))!;
  const superName = className(view.getUint16(pos + 2));
  pos += 4;
  const interfaceCount = view.getUint16(pos);
  pos += 2;
  const interfaces: string[] = [];
  for (let i = 0; i < interfaceCount; i++) {
    const name = className(view.getUint16(pos));
    if (name) interfaces.push(name);
    pos += 2;
  }

  return { name: thisClass, superName, interfaces, references };
}

/**
 * Builds a minimal, valid class file for `public class <name>` (extending java/lang/Object)
 * whose constant pool additionally references every class in `references`.
 */
export function makeStubClass(name: string, references: Iterable<string>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let cpCount = 1;
  const pushUtf8 = (s: string) => {
    const bytes = encoder.encode(s);
    const buf = new Uint8Array(3 + bytes.length);
    buf[0] = CONSTANT_Utf8;
    buf[1] = bytes.length >> 8;
    buf[2] = bytes.length & 0xff;
    buf.set(bytes, 3);
    parts.push(buf);
    return cpCount++;
  };
  const pushClass = (utf8Index: number) => {
    parts.push(new Uint8Array([CONSTANT_Class, utf8Index >> 8, utf8Index & 0xff]));
    return cpCount++;
  };

  const thisClass = pushClass(pushUtf8(name));
  const superClass = pushClass(pushUtf8("java/lang/Object"));
  for (const ref of references) pushClass(pushUtf8(ref));

  const header = new Uint8Array(10);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0xcafebabe);
  hv.setUint16(4, 0); // minor
  hv.setUint16(6, 52); // major: Java 8
  hv.setUint16(8, cpCount);

  const tail = new Uint8Array(2 + 2 + 2 + 2 + 2 + 2 + 2);
  const tv = new DataView(tail.buffer);
  tv.setUint16(0, 0x0001 | 0x0020); // public super
  tv.setUint16(2, thisClass);
  tv.setUint16(4, superClass);
  tv.setUint16(6, 0); // interfaces
  tv.setUint16(8, 0); // fields
  tv.setUint16(10, 0); // methods
  tv.setUint16(12, 0); // attributes

  const total = header.length + parts.reduce((n, p) => n + p.length, 0) + tail.length;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(header, offset);
  offset += header.length;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  out.set(tail, offset);
  return out;
}
