// Unit tests for the Java-subset interpreter (tools/scenegen/interp.mjs). Every expected value below is what `javac` + `java`
// produce for the same source (derived by hand from the Java language rules; the JLS section is noted next to the less obvious ones).
import { describe, it, expect } from 'vitest';
import { createEnv } from '../../tools/scenegen/env.mjs';
import { ser } from '../../tools/scenegen/serialize.mjs';

const env = createEnv();
let counter = 0;
/** compile `body` as members of a fresh class and return a function calling its static methods by name */
function jclass(body, extra = '') {
  const name = `T${++counter}`;
  env.store.addSource(`t.${name}`, `package t;\n${extra}\npublic class ${name} {\n${body}\n}`);
  const cls = env.rt.sourceClass(`t.${name}`);
  return (m, ...args) => {
    env.rt.activate();
    return ser(env.rt.invokeStatic(cls, m, args));
  };
}

describe('arithmetic', () => {
  const j = () =>
    jclass(`
    static int intDiv() { return 7 / 2; }
    static int negDiv() { return -7 / 2; }
    static int negMod() { return -7 % 3; }
    static int prec() { return 7 / 2 + 7 % 3 * 2 - (1 << 4); }
    static int overflow() { int x = Integer.MAX_VALUE; return x + 1; }
    static int shifts() { return (-16 >> 2) + (-16 >>> 28) + (1 << 33); }
    static int cast() { return (int) 3.9 + (int) -3.9; }
    static double dbl() { return 7 / 2.0; }
    static float flt() { return 0.1f + 0.2f; }
    static double mixed() { return 1 / 2 + 1 / 2.0; }
    static int charArith() { char c = 'a'; c += 2; return c + 1; }
    static int divZero() { try { return 1 / 0; } catch (ArithmeticException e) { return -1; } }
    static boolean cmp() { return 3 < 4 && !(5 <= 4) || false; }
    static int compound() { int a = 5; a *= 2 + 3; a -= 1; a <<= 1; a ^= 3; return a; }
    static int incdec() { int i = 3; int a = i++ + ++i; int b = i-- - --i; return a * 10 + b; }
    static int bits() { return (0b1010 & 0xC) | (3 ^ 1); }
    static long lng() { long a = 1L << 40; return a / 1024; }
    static int tern() { int x = 5; return x > 3 ? x > 4 ? 1 : 2 : 3; }
    static int mathfns() { return Math.max(3, 9) + Math.min(-2, 4) + Math.abs(-5) + (int) Math.floor(2.7) + (int) Math.ceil(2.1) + Math.round(2.5f); }
  `);
  it('integer semantics', () => {
    const t = j();
    expect(t('intDiv')).toBe(3);
    expect(t('negDiv')).toBe(-3); // JLS 15.17.2 truncates toward zero
    expect(t('negMod')).toBe(-1); // sign of the dividend
    expect(t('prec')).toBe(3 + 1 * 2 - 16);
    expect(t('overflow')).toBe(-2147483648);
    expect(t('shifts')).toBe(-4 + 15 + 2); // 1 << 33 == 1 << 1
    expect(t('cast')).toBe(0); // 3 + (-3)
    expect(t('divZero')).toBe(-1);
    expect(t('compound')).toBe((((5 * 5) - 1) << 1) ^ 3);
    expect(t('bits')).toBe((0b1010 & 0xc) | (3 ^ 1));
    expect(t('lng')).toBe(2 ** 30);
    expect(t('tern')).toBe(1);
  });
  it('increments', () => {
    // i=3: a = 3 + 5 = 8 (i=5); b = 5 - 3 = 2 (i=3)
    expect(jclass(`static int incdec() { int i = 3; int a = i++ + ++i; int b = i-- - --i; return a * 10 + b; }`)('incdec')).toBe(82);
  });
  it('floating point', () => {
    const t = j();
    expect(t('dbl')).toBe(3.5);
    expect(t('flt')).toBe(0.3); // printed as the shortest float32 decimal (0.1f + 0.2f == 0.3f)
    expect(t('mixed')).toBe(0.5);
    expect(t('charArith')).toBe(100); // 'a'+2 = 'c' (99), +1
    expect(t('cmp')).toBe(true);
    expect(t('mathfns')).toBe(9 + -2 + 5 + 2 + 3 + 3); // Math.round(2.5f) == 3
  });
});

describe('strings', () => {
  it('concatenation follows the Java numeric/char rules', () => {
    const t = jclass(`
      static String a() { return "x" + 1 + 2.5 + 'c' + 1.5f + true + null; }
      static String b() { return 1 + 2 + "x" + 1 + 2; }
      static String c() { return "" + (char) ('a' + 1); }
      static int d() { return "hello".indexOf('l') * 10 + "hello".length(); }
      static String e() { return String.format("%d-%s-%.2f", 5, "x", 1.0); }
      static String f() { return "A,B,C".split(",")[1].toLowerCase(); }
    `);
    expect(t('a')).toBe('x12.5c1.5truenull');
    expect(t('b')).toBe('3x12');
    expect(t('c')).toBe('b');
    expect(t('d')).toBe(2 * 10 + 5);
    expect(t('e')).toBe('5-x-1.00');
    expect(t('f')).toBe('b');
  });
});

describe('control flow', () => {
  const t = jclass(`
    static int loops() { int s = 0; for (int i = 0; i < 5; i++) { if (i == 3) continue; s += i; } return s; }
    static int whileBreak() { int n = 0; while (true) { n++; if (n > 6) break; } return n; }
    static int doWhile() { int n = 10; do { n++; } while (n < 5); return n; }
    static int labeled() { int c = 0; outer: for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) { if (j == 2) continue outer; if (i == 3) break outer; c++; } return c; }
    static int sw(int x) { switch (x) { case 1: return 10; case 2: case 3: return 20; default: return 30; } }
    static int swFall(int x) { int r = 0; switch (x) { case 1: r += 1; case 2: r += 10; break; case 3: r += 100; } return r; }
    static String swStr(String s) { switch (s) { case "a": return "A"; case "b": return "B"; default: return "?"; } }
    static int swArrow(int x) { return switch (x) { case 1, 2 -> 5; case 3 -> { int y = x * 2; yield y; } default -> -1; }; }
    static int tryFinally() { int x = 0; try { x = 1; throw new RuntimeException("boom"); } catch (RuntimeException e) { x += 10; } finally { x += 100; } return x; }
    static int foreach() { int[] a = {1, 2, 3, 4}; int s = 0; for (int v : a) s += v * v; return s; }
    static int arrays() { int[][] m = new int[3][4]; m[1][2] = 7; m[2][3] = m[1][2] + 1; return m[2][3] * 100 + m.length * 10 + m[0].length; }
    static int varargs() { return sum() + sum(1) + sum(1, 2, 3); }
    static int sum(int... xs) { int s = 0; for (int x : xs) s += x; return s; }
    static int recursion(int n) { return n <= 1 ? 1 : n * recursion(n - 1); }
  `);
  it('loops/labels', () => {
    expect(t('loops')).toBe(0 + 1 + 2 + 4);
    expect(t('whileBreak')).toBe(7);
    expect(t('doWhile')).toBe(11);
    // i=0: j=0,1 counted (c=2) then continue outer; i=1: +2; i=2: +2; i=3: j=0 -> i==3 break => 6
    expect(t('labeled')).toBe(6);
  });
  it('switch', () => {
    expect([1, 2, 3, 9].map((x) => t('sw', x))).toEqual([10, 20, 20, 30]);
    expect([1, 2, 3].map((x) => t('swFall', x))).toEqual([11, 10, 100]);
    expect(['a', 'b', 'z'].map((x) => t('swStr', x))).toEqual(['A', 'B', '?']);
    expect([1, 2, 3, 4].map((x) => t('swArrow', x))).toEqual([5, 5, 6, -1]);
  });
  it('exceptions, arrays, varargs, recursion', () => {
    expect(t('tryFinally')).toBe(111);
    expect(t('foreach')).toBe(30);
    expect(t('arrays')).toBe(8 * 100 + 30 + 4);
    expect(t('varargs')).toBe(0 + 1 + 6);
    expect(t('recursion', 6)).toBe(720);
  });
});

describe('classes', () => {
  const t = jclass(
    `
    static class Animal {
      protected String name; static int count = 0;
      Animal(String n) { name = n; count++; }
      String sound() { return "..."; }
      String describe() { return name + " says " + sound(); }
    }
    static class Dog extends Animal {
      Dog(String n) { super(n + "!"); }
      @Override String sound() { return "woof"; }
      String describe() { return "[" + super.describe() + "]"; }
    }
    interface Shape { double area(); default String label() { return "shape:" + (int) area(); } }
    record Rect(int w, int h) implements Shape { public double area() { return w * h; } }
    enum Color { RED(1), GREEN(2), BLUE(4); final int bits; Color(int b) { bits = b; } Color next() { return values()[(ordinal() + 1) % values().length]; } }
    static int counter = 100;
    static int nextId() { return ++counter; }
    static String poly() { Animal a = new Dog("rex"); new Animal("x"); return a.describe() + Animal.count; }
    static String iface() { Shape s = new Rect(3, 4); return s.label() + ((Rect) s).w(); }
    static int enums() { int r = 0; for (Color c : Color.values()) r += c.bits; return r * 100 + Color.BLUE.next().ordinal() * 10 + Color.valueOf("GREEN").bits; }
    static String enumSwitch(Color c) { switch (c) { case RED: return "r"; case GREEN: return "g"; default: return "b"; } }
    static int statics() { return nextId() + nextId(); }
    static boolean inst() { Object o = new Dog("d"); return o instanceof Animal && !(o instanceof Rect); }
    static int anon() { int base = 5; Shape s = new Shape() { public double area() { return base * 2; } }; return (int) s.area(); }
    static int inner() { class Local { int twice(int x) { return x * 2; } } return new Local().twice(21); }
  `,
  );
  it('inheritance, super calls, statics', () => {
    expect(t('poly')).toBe('[rex! says woof]2');
    expect(t('statics')).toBe(101 + 102);
    expect(t('inst')).toBe(true);
  });
  it('interfaces, records, enums, anonymous/local classes', () => {
    expect(t('iface')).toBe('shape:123');
    expect(t('enums')).toBe(7 * 100 + 0 * 10 + 2); // BLUE.next() wraps to RED (ordinal 0)
    expect(t('anon')).toBe(10);
    expect(t('inner')).toBe(42);
  });
});

describe('lambdas and collections', () => {
  const t = jclass(`
    static int closure() { int base = 10; java.util.function.Function<Integer, Integer> f = x -> x + base; return f.apply(5); }
    static int supplier() { int[] c = {0}; Runnable r = () -> c[0] += 3; r.run(); r.run(); return c[0]; }
    static int methodRef() { java.util.function.Function<String, Integer> f = String::length; return f.apply("abcd"); }
    static int list() { java.util.List<Integer> l = new java.util.ArrayList<>(); for (int i = 0; i < 5; i++) l.add(i * i); l.remove(Integer.valueOf(4)); return l.size() * 100 + l.get(2) ; }
    static int map() { java.util.Map<String, Integer> m = new java.util.HashMap<>(); m.put("a", 1); m.put("b", 2); m.merge("a", 5, Integer::sum); return m.get("a") * 10 + m.getOrDefault("z", 7) + m.size(); }
    static int stream() { return java.util.stream.IntStream.range(0, 5).sum(); }
    static int bi() { java.util.function.BiFunction<Integer, Integer, Integer> f = (a, b) -> a * b; return f.apply(6, 7); }
  `);
  it('closures capture effectively-final locals and arrays', () => {
    expect(t('closure')).toBe(15);
    expect(t('supplier')).toBe(6);
    expect(t('methodRef')).toBe(4);
    expect(t('bi')).toBe(42);
  });
  it('java.util subset', () => {
    expect(t('list')).toBe(4 * 100 + 9); // [0,1,9,16] after removing 4
    expect(t('map')).toBe(6 * 10 + 7 + 2);
    expect(t('stream')).toBe(10);
  });
});
