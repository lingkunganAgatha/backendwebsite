/**
 * Backend Arsip Surat St. Agatha
 * Cloudflare Workers — Hono Framework
 */

import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
interface Env {
  JWT_SECRET: string;
  ADMIN_PASSWORD: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GOOGLE_PRIVATE_KEY?: string;
  GOOGLE_CLIENT_EMAIL?: string;
  GOOGLE_DRIVE_ROOT_FOLDER_ID?: string;
  FRONTEND_URL?: string;
  APP_ORIGIN?: string;
  CORS_ORIGINS?: string;
}

const ROMAN_MONTHS = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];

// ─────────────────────────────────────────────
// Supabase Storage
// ─────────────────────────────────────────────
async function uploadToSupabaseStorage(
  fileBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
  supabaseUrl: string,
  supabaseKey: string
): Promise<{ file_path: string; public_url: string } | null> {
  try {
    const bucket = 'arsip-files';
    const path = `uploads/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': mimeType,
        'x-upsert': 'true',
      },
      body: fileBuffer,
    });
    if (!uploadRes.ok) {
      const errData = await uploadRes.json() as any;
      console.error('[Storage] Upload gagal:', JSON.stringify(errData));
      return null;
    }
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
    return { file_path: path, public_url: publicUrl };
  } catch (err: any) {
    console.error('[Storage] error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// PDF Generator menggunakan pdf-lib
// Mereproduksi template DOCX "Surat Pengantar Pindah Lingkungan"
// ─────────────────────────────────────────────
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// Logo gereja (embedded base64 agar tidak perlu fetch runtime)
const LOGO_LEFT_B64  = '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';
const LOGO_RIGHT_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAFYAAABiCAYAAADKvSRMAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAADq9SURBVHhe7b33VyPLsue7/9n3072z3tzjtmuP90ggnECAkEAIEEbCe+8a7733Vt7Sn1mZpUJCDb33mTmz5ry3prpjqSozKivrm5GRkZGRxU9ujwe3xy3J41XPxa9XksfrxeV2PfP8EcXK+Pehf6b+/yr6KTEhRgKgfz+Q/r9CPwBWoX9la/8ry/p3p588ovu+kvF/mt5qhLfS/93oD4H9d9SZ/7vof/Vd4+//6SkS4dvTE5FIhHA4LCkUDhN5isg0cYjfp29PSlocibTX0tW8eJ7X+N5Kf43nLb74vNd4/uj+RL630t/KT+RTr3/69vRNgifAFSALEOMZ1TxxxD8g8UisgJr2Fk/ikXjfj/jieRKP1+rxVt5rfK+lxR+J9yXyqtevAxuVVJGnSrQ4ElswsbDEvHie1/jeSn+N5y2++Lw/w/MWvcWTeCTmJ/Kp128D+02kRcF9o9Lxx2t5f4bnrbw/yxOf92d43qIf8cQfiXmJPOr1d8AKHRuJPPHt/wL7Xd5b+a/d/wysAPUFsBLUuBJfKfSP8v4Mz1t5f5YnPu/P8LxFP+KJPxLzEnnUawls4sD1f4F9Pe+t/Nfufwb2pTUg0mLAqje+VdhbeX+G5628P8sTn/dneN6iH/HEH4l5iTzq9QtglUShU//PAZtoeSSWl0jx9/8ZnrfoRzzxR2JeIo96LYEVJzFgBSngClKZXys0/ngt78/wJOb9/wrY+ITEF1PzXis0/ngt78/wvJX3Z3ni8/6YRxWYH/GI65hgqcL1Mv97SsyPAisKEIB+D6rK/Fqh8cdreX+G57V0QYmzP5XvtYZX8178Ric2L3neBje+HCU/xh9/JN73+v1xwEaewt8Bq94Q/5uYl1jga/f9iCc+T53xxb98Ik982fH5iekCVBXYmEp7WfZrdVH5/0XAfj9djb8h/jcxL7HA1+77EY96iOcrPLG0RN7E+9+S6u9JBVYBNdFp8v39/yJV8E087MXg9f2LJF7HF/ZW3vc8P6qwmq6Aq1grMUCUX7X8KECyzkr9BcXKifEk1kfQa0IUq8fL9O/f4fv81+7/SaQJitdJKqNyrlRQVPutwuILTLz/JU8ccHHpStkQEcQ3wrIbq1NqED6g54nMc52EO1PwKY6ip4hgigf2n6NYHd/Oeyv/tft/egqLij0RCYVf2LMqUyRK/zywygu+5PmmgBcFQJWcUCRMMPKEPxwm8CTOw4SCYcKCwspMUEy1RT2FrzgUiRCS6d9k/lPkG+I9lIZIlO7vKfYusd4j0l57x+/f4fv8eB71+idRWTmdDYmKK9NalVE8TvyLSDl6qZv+6IGqpREvm+IFhDQKegY1HMIX8HN1d8vm3i47B7scnx6zvb3N2uoaW9tbnJ2fc3l5yeOjU64cH5+ecHp+TjAUwR8Uvg14CoN4nGqXv1ZP5TpeRbzsQf9SYNWuFAl/L7EKrAKIkHL2RmHxBcbyVEtDXCv6UEhb+CmiSGgoiD/g4/r2ioOjA+6cj5JuH+/w+j14vV48bo9cfvf7/QQCQUl+f4D7x0eub27Z3N7m8OSUy6sbQoFvRILiOTHdm1hPcR6Rjavm/28GVnXCvC6xT88Sq9wUa/H4I/Ehz+dR96P0mkVBdfs83N7fcn17jcvtlEAK0IOhkGwMiD4/zkRQnyvyRaMIVeHx+nC6PZycnnNyfIHr0SelV6iJt+oogJVd/0nR0YISVcGPeqZaTiIl5v0JYGOqQK2YUjmlgB+1dLyXTAAbCAY4PT+VgIoFN3EdDAUIh4OEwyGeImG+fRPOoJikx0ue8sLCtSl4nwiHhCqJ4PeH8HpC3Fw/cHV1QzCkuD4lyQFPbRQFcHVwVKRbyY8BE+NTKf5IfEeVEvOfgVVJzRSHKDJx8IoHVq3Aa8DK+5++KYNQKML9w72U0gfnoyJxYSGZyn3fxD2yYRVgJT3FXjqxbPnyYsCSJO4Vg+83Ar4Qj48uzs7OpS4WACvSK+zkl3VTQFWeoU5MlPdQARXnyvVrR+K7JqYrEwTZXaPgRiuuHi8f9lKCVHrmkQNHrJVFecFAMDrouPEH/FFHutoz4iRFmnsC1BDfvgX5JvS6oG9Bnp78fHsKAkKShbpQpFs2hPAfRyVYWAbBQAi328v9/QMPThcBYe08v0OsweOBFZaFyFKBfAY2qi5k/aT6eElv4SGBVbrrS1UgWzDax8WN4lrVSfL6SV1pUAYkpdVFfqx7ie7qdju5vr7C5/M9L60rZpNid6rlCd5QKMC3SICnsJtvERdPoQeeIg98e7rnKXTLU+iep+A9oeADT08enp68EvBI2E8w4CMUFOCKsp4IBiOEgk+4XB4uri4JiPKj9VWfrUh7jFSV9axC4oBXQFXt/dg98Xi8Cqy8iIsrUMBWChGHei10mvpgUTnFolAqGQ4p5PcHuby6YmJ8lLX1FXw+b1QalQYS5cv7hN0pumnYz1PYw+P9Oft7y8zN9DI33cHMWDMr8x1MTzQyOWpleqSRmbEWpiccDA428/XrIAcHazw6LwiH3BLgSCikxEUEBT3hcfvYPzxgdGyE88uzOF0uVId4tlKPmA0cHWTjgFfePQ7YuHuUBon1UEWyE4GNI5kW90DRckqhcfaiBOabrGBEDCJBhVxuN/39fYwMD3B3eyVfRAFTNJQyEQkHQ8qLhQI8BR8IuE7YXhvFYSulrVHLYFcZY/1lrC1Y2F5rYHG6ipWZGhYmauhxlFBXk0NTQwltbVX09zeysTmN13NNJOQiFPAQDgYI+UNRnfvI8soig4Pd3D9cSekW6klMPkT9n99TvOOzzo4B9/zu4lf04FcaQ9CrwCY6JSQQAjxpcCvACt2lgip/BcihJ8KBMEF/SEprIBBicWmBvv4ebm4u5UsIYFWJl2CKWZVI93uI+O85P1xgc6mbmREzU0OVzE+ZWF+s5/yonbuLTm4v2jg/sHK0YeJ4o57FyWq62wpptmppbNBhaymjo8vE/uECD48n+Hy3REIeIsEAT6EIAb+fR+c9k5NDLCxN8/B4SygYlHkvQFKBTZBIZXanWCCqxCZK7qvAKqL8vcTGWiMq7s8PFQAJ6RSSqpDQb75AgK2dLXp6O7i4PCEY8Mt0UZY67VSk1YfXdcPu5ixLMx0sTjawt9rK9VE3D5f9uO9Hcd2NEHCPE/KOEHR3E3A6cF/ZcJ63sL9sYrq/hFZrDg31+dQ1aKmp12DvNjI01sLJ+Rr+gCK9TyGhHsLc399xdX3C8Ggvs3OT+ANewkJQggpgArgXgCaAG6+Dv8uP8qg4quDGrSDERrl4YFWdqoIoQFWADT+nBQIBHt2P9A/1srg8i9srBp7Ic6VFq8vBJRTg6GiLr9M9DPfUsDBp4WSnk8fLAYLOEUKuUYKeSQKeaYK+aQKeEfyuTkJuO0GnHf91K4dLVaxNVtDdnIe9pZAqcxZ6cxa6ijQM5nx6BhtY25zg/Hybh7tz2TtEIweDHg5PdunobuPk7JBwMEgkIEzBKLB/AN5beTGMXtq+z8A+3xgPbHTWJAcqAVAUSFGgAFfoKQlsMMDS6jzjk0M4XXcEg2KUVgYQOY8XeisUwPV4hb2thuYmHXOTNTxcDhBwTRL2ThL2jeNzjhD0fiXkXyQSXsbvnsDv6ibocuC/bcF/08b9fgOHy7XMDJfT1qLBYM6i1JRDVkkyaQWfKKvJw9paQZu9hrnZQQJeJ08h0aghHp13zC1O0dnTxu3tNX6vT9ZfgBsPVCJ4bwIbZwfHQFXMtugE4aUJ8TwqRgtQBpqIHHQEmELfCt0qSOTdP9zS1W1n/2ibYNAb7fJCRaiWRoCHh0tGhx20NJfR2a7jaLeFkHcMv0uAOUbANYzvcYSwb45IYJmwb5GQe5Kgs5vAQxvOMyvnm1WcrFSxMlbMYIeGxoZsCWx+eSrpuiQ+5b7jffo/+JD6V4r1GdRby9nbWyMc8BLyBwkGAlzdntLmaGR7ZwO/zxsVgHDcuyo9Mh5A9VodvJ7zpf5VzLhYr48Cq0qrWsgLcyu+daLgqg8WoAZ8AVm52ZkpOeqenh0S8PtkXsivNEAg6OXweAuHw0J1dT4NTRp6enRsr1s42Wvk/rKTy+NWXFfdXB87eLwc5Pygk9PdNlyX3fiu7dwdmrnaquRkqYzd2RJG2zPobsumtjaNcmMmhZWZpGo/klGUTFZRKtlFKaRkv6OwNBOL1cDe3joP93fSGvB6HlhcnGZ0bAC391GqKAFszMpR1Jz63s8qMW7weqb4KbH4HzfBiDm65cgY06lquponChajv6JblXMhwVdX57S3t7C6uoDf5ybkDxAUgHv9+Lwujo63aWk1YTRqMRjS0Zd/xNaUzlBPLlOD+SxNFzPZn8Pxeh3nW41c7rZxvN7I/pKZ41UTt/sWHvZruV6r4G6zmustE4sjhfTYs7HUpaOvSpP6VVeVSXFNLvn6DNILkviY+Stfsn4jT5eCsbaUzi4HDw/3PN7fcHK8h6PDxvLavLSzpcUjpDAqNPESq57/CNjEwf57YKMZciSP6tL4wuS8P6xYBMI6EMBubi0zNNTN3d21NG18Hp/UXW7nPbMzIzQ1VVNSkkF5eRoNDRpszXmMDJWyMFnO1kIVZ9sWDpar2Zmp4HSllsuNes7X6njctXG7aeF6o4bz5QqOpnW4dszcCmCHNQw4cmi15WCqy6LOVkBZTTolxnQKBMjVuaRoP5Gu+0JRdRaGugKa2+vZ2l3n8uIMj+uB0fE+JmaGpIUg7dpAWAE3HrgEqZVYRCdHiXh9D+zzAKVORRVVIIBN1DUiTdp00q4TsywfX+fGJImWF44Q0fper5v19Xkam6qpMORjqMyhqiqTlhYdk5NmRof0rH41Mtmbz9ZcJYvDhWxMlHGxKkC1sD9r4HTRyP5UGUdf9RxOl3A4UcT1chWnywbmhzT023Nos+XS1KyltiEPc1M+xsZ8Kiz56Ou0FFTnUlCTS2FNJiXmHCpqi+jqd7C/v0fQ72N9a5G+oQ45oAl1IIGVE6Dv9exbwL4mseq1nCAoelaZcir0/eAl8mUFoqOosE0fHu8YGevl+GxPOqV93iD+YIij033sHRZqaoswmguprtHQZCthbNTC2IiR0aFyFqeNUur6WjOY7NEw169jdaychaESprs1rI6UsjVRztZ4Kcu9eaz25rHUk8PCQD7T/Rram7JoacylyphKYdlHDOZMSmsyKavNJ1efRlZZKrkV6WiNmRTX5lJYmU2Tw8Lm1gY+j4ezy0M6ulu4ujmXAhIOKL1QtdOfB6w4UOOBlRaSGLyiKyKJ+T8JsX12Caox9QmDl1TmcbasAF24/g6OFF11fXvO2dkZXk8Ab9DPwvoc5gY9BrOWOpueCmM+VlsZ3T1GrNZcejqLGB8op7ctl5FuLf32bHqa0uhrzqTHlom9Lomp7gIGmlIZbkljuj2L+c5sph3pDDR/oacllTZrOnU1KVQbU9AW/U5+0XsKKlLILPpEmu4TmaUppBcnkV+dQZm1gOIaDTXWSnZ2tvE43fj8j9L0OjjeJRD0SysmHtR4kqDFmZ7xqkCsRgiKAas4eX4SaCsjWWxKmwhsTIEr6kFIqwB2bX2Znl4Ht3cX3N7cyCnt6c0ZllYzBksxucWpVFiKKDTkoBcvVl+ItamQWnMGTbUZ1Bo+0tWaRWdzOj0tmTTWfMRU8RvWmo/YTB9oqPqFJuOvdFk/MdqazExXBp0N72iu/Q1HQyrG8t8p0v2d0vIP5BT8Sk7RB9J0H0guFL9fSNV9Ibcqk1xDJim5n2l1NHF1cYn70YXP72R6dozRsUFFz/rFTCymBr4D9rmrKySlW7oDxMqI4rGL9foosH8ksWrrqDpIFCg8RUvL8wwMduNy3ckBS6xPXT5e0NhpIb8sk/SCLyTli0EkBU15JprSZEr0SZQWv8NWl8FAu5axfh3jAzqGu7WM9hUx3F/M2FApwz3CYihnebaclZky9pcqWZ0sZGFCw9J0EZMDGkZ7tXS359LRocVcn0W5OYO8imS0xiyKawvILc8k25BBSmESJZVFLC0v4HF6CAvrJuRjdX2BgcEe6UsQ9rkANv6d499dJTG2xAMr/NeKY15gFgesWA34I2CVlhO/Qi0oRn8oImZbCwwO9XF7dy31r1hmuXaeY7ZVoinLICn3Pe8y30lK1n4gq/Ad+oovtDblsDBRzclWC7dn3dxe9HJz1s/D1QjOuwkebodx3vbivO3Cfd+D96EH11Ubzstm7s4buDm1crJjYn+9hv0NC2uLtfT2FVHfkk95fTba6gwyS1JJK0olozSdtMJUWttbubq6JuQXE50woZCfre01enrbubu/lja58IYpqi5mYqm9VSVllqYKWGxckqCHhVpQdO5P6rrWa06YmApQrICgnGkplkMg6GNgsJeR0SEenQ/SGhDqwRW4p72viUJ9JtlFyfya9iufcj+SVviBgvJPNNlyWJg2cr7fhvd2kJBniqB7hqBnnpB3Sc66Qv6v0k8Q8Azicw8S9A7he+zBfdeO77Ed770d93Ur92fNnO1amR0rpr+3EEtTFpUNOeSWJ5NakESyNpkk7RcKDFp2DnbwefwE/cpMKxIOsru3id1h4/rmgseHR8IBdRx5ORNLFLJnoF+xCoSQCmF9AewLiY33PUYdFKr7THqzfG66ezro7u7i9vZOSrOwa0NhLysbszS0VFBUIdRBMimaj9LGrK5NYXnBzNWRnfuLDvyPw4T984QDq4QCW5Kewlv4vQt4XGOEAhN4vWP4vGMEvWK6O0zIO0jYPyR/g85+3NfdHO3YmJ6oxtFVQmNXGYXVmeTps/mQ+YEveZ8xNlZx93jzPCUP+ANEQkF2tjew221s72zicrpeBVbQa8CqvlwVWBUjsewq6CdlqTlu4HpFFSgrB4pfUpl5icp5GBzoZWxsjLu7e/zeqJEdCeLx3rCzN0NTq56iymzFSDdnUFefwvyUnpvjFty33YQ8Y4R880SCm0RC+zyFDwkFdwgG1wgGFggF5wgG5wkEZgn5Jgn7xwl6Bgk4+/A/9uK/78F13cXZQStjQ3o6OosxNeahq0wnTfOFpJxPZBQkU1ypYXZulKPDHbxuJ6FAQDrDtzbXaW1pYmN9FfejO6Zj4xz90vccb27FAx4HrMgT4hoHrNSwPwRWeZgCsApsKOBldnaS6dlpnG53FFiltUPBR+5vt+nsqsZgyqXClEWVMYUGSxLby9W4L4UbsF86YSKBeYLeFUL+Xfy+Pfz+HTzedXz+NQlwJLJB0LeI83ZE+hJujpu4PKiT9HjRwvWRjcXJMjptGdismVgFsGVJZOR+IE+XSll1HpUmDdaGMoYGWrm5OiYS9PEUCrK1uUGzrZH9vV05oMWsAtUJrgxSqsM/EZN4YBW1oKxgS2AjETFNDcZAfQXYeF2rAhsO+tncWqNNDAq3N3JQE44XZdnFhftxj6WlLipN2ZRWJNFozWR8oIjzPQve61acV3bODmxypeD8ZADn/SJ+7xaB4A6+wDZ+/zY+3yYB/wbnpyNsrzRydWDnYreOm4M6bo4tOC9bcF3ZOVg3M9Groas5mw6HjsrqdHQlyRhrC6hr0GFtKqLeqqXZVsbywhhh36N0gh8d7tPV2cHt9TVBn/AXJA5YPwZWkOrdes6Phgf8pCwjC09/3PLMD4BVSDiI/ZydH0lgzy7PlZlLSHjBhOQ+4HzcZWmlC5u9BFNtBj0OLVsLJq4OanFfNnB3auV8v57zwxYOd1pZW2ri60w96xud3N4v4RcS7N/h9m6eoX49/e1adpfqONuq4/bIiuuqBe+9A99DB84rBycbdWzO1dBt12CqSaPamElTSwk1tTk0NRfSJLxqnRWsLgwS9t7wFPKwtbXB5MS4HCPEoKZYPomWwPeqQFoG6rJNdB6gHmrcxU+K/SXW87+3Cn4ErGiMm9tLmtuaODw+kPah8Mg/CWPbd836xhCOjjIcXXra24voaMriYKWWh9N63Jf1eK6bpQl1fWKX5lKXPZ+GunSM1UkMDFZxfb3A/f0KX7820mjNoLU+neH2PDa/VnCxV8/deSsPV23cnDXivW3HedrKyYaVkZ4i6s1pGKvTKNN/IU/zMzXmDOotmbQ1FzI/1Y7PeUok5GRhYZb5uTkeH5zSKZ84nVXpWWKjA7o4F6AKv2tsgqWQMhOLj4R5A9jXf8XDQ3g8TsbGhzg43JVerZDwyAce2d6corvTIKevLW06OjuK6W/L43DZzONpPYG7JgL3di4OrOys17Oz0cpwXwWmqhQM5R+w1KazONfK+lon9fUZVFW8o9GULMuYHy2l35FOZ0sSU8MatlcruD1t5P7Extl2A2N9hdjq0zGb0ijU/Y6pNhNbs4auzhLsLTpGBqz4XCe4XZeMjQ5ycnSMx6k4kBIBle+rAhsFV6arZtaz6oypgucJgrqCkOiEeU1iBUkLQV3r8ntZXVtgaKhXzr8jgQAR/w2zk3bszYXYGnKpq8uSSygzA3r2F03cHJjx3TZxeWhmda6MtqZk9MX/oLLsAw3mTJos6YwOlHN9PsHaUgvWumTM1WIam8REbxFzoyW0Wt5jNvyVHnsyC1MadtfKuTywcHPUzPx4Gd3CBzFooN1RRFdXCe2OQvq6S7A3F9DbWYPXdcL+/io9PQ7OT88U/RqVVulginvf14CVnr/okkz8woACbNS7peqGWOLbwKpmlyRReDjI+cUhbW2Ncg7+eHuNz3nCwkwbw116Opo12BrysVlzmewpY2ummivhtD42c39u43jHwteJMuxN6bQ1ZNFrL2CkW8feejMh1xxHOw4WpipYE67F8VI25yo5361naaKApalC9tYq2V4pZW1Oi+/WjueqnZ1FIyNd+Yz2ljDYU0JnWz59HQW0N2Uz1F3O/EwHAd8Fs1+HGBsbwOV0Ru3XaOBJ1C0a7937bvB6jj94KYgvgI1JbMwnmwjsC2mNW2cXMVN39xd0dDSzvbVJ2Oci5D1jd2OAqYFKBhyF9LaXUF+TTrslg92FWpyXrQQf2wk6e/Dc93B31cXaYg0jPVqWJqtYmjTguhwk5J7h4rCd/XUTnpsOHi/auD6y8njeiOvShuuqFfetneuTOs4Pagg6O3g8b2F3sYqRjhzs1lTpWlyYqJLrY6NdxXwdrePybJnHh2P6+tpkb1OWZhT9qnjtRJioGEPigH3Njv1jYBNviM201LTn5ZiAsjSjXgtgg0EXu7trDPR1c3K0Q9B7wd7GMJN95fS35jLWW47dms1ol46jjUa8952E/b1y9iSmrF5nL1enQnqFCdXK1nw13usBuZB4fynWwRoJPDgIujrwPrTiurHivbfhvrfzcNOG+74N70Mb/ns7V4f17C5XM96dR7ctk6UJIydbrSxPGpkfMXGxP4nffcz83Aj9/e08PgozMfhi7v+qxMYDGx/UkdDD3wBWpVhh6vn3VoHadYQ68MsV2LGRflaWZ/B7LjnZm2ait4zh9nwmektpq0vDbklhfa4K962DoLuLcGCYkH8Yv6cXz0M73ju7tBIO1moIPgwR8kzivu+X/P5HO0FPOz5XG353MwF3G35PD2H/IJHwEAFXF/cXNo63zazPVXK02cLOio31eSuzI+UcbAjQxwm59rm92aWjs5HpyWE5C1MsnBh4ao/8c8DGxifpr43u9klY83oJrgqsCmL8tRIFE80TsVkhL1tbS/T1tnJ1sc/txTojPaUMteeyv2Jj46uF0U4tY9253J0KqbUT9PYT9A0S8gtHTC9BZydXhxa2Fyvw3/UT9k3heRjk5qwJz30bYV83Pnc7QV87Pk+7bJRIaEL++lx9XJ7YmB3T0d+lYXq8momRaqy1abTaslmeb8b9sI3XdczK6jiDQw4O9rcJ+vzPy03PgEV7bKJQvQA3Dth41anQHwErfY7fAyu7i0xTAn2VADM/9/cXDA60MzTg4Ox4gV67Bnv9F0Y6NDyeDXF30svpTpME7/GyAe9jByFfn6Swvw/vTStHGwb2VwwE7hVgz47aWJrVcbxrlFId8vcQDHTh83bi9/ZLUN2PPTzcdnK420hfZx62xiyaWzTYHTpqLZlYGjIZHDKytNzH9s4M7Z21nF3syAVFGRvxHGL0sscm2rQSp4SgOKVR1NBU5VoB9keqIEoquGo3kD5HGX75Tc62ROV8Hi9+r4ft7RW6OuqZnWqhuy2HgfYsRrsLWJw0sr5Qx8aCkbNdE64LqwzCEBEuAXc7IXc7rosGzraqON8x478TYM/IoI7Z0XzuL5o52Kkh4OnB7+3C7XLgfmzF73bwcNPC7paJ+dkqmpuyKSv/jL4yBWN9NpW16RitGdQ359FqL2FkxMryyiBO16mMIZPO7WfhUcCMASre7/vJgsRCFbxXJFZeK5+HekV3JACrtphakLr+JUIlleCMIJFgEL/3jp3tCYb6DEwMFrEyW8nCpFGaO/3dhfR35TI3ms/1oRnPVSOB+2bcN8qv77qRnYUi1mZ0CrDeKbZW65gaymV1rpi9LSNeERXj7SHg7cDnbMZ128DlsYXF2TIcbXmUln1Co/tAoT6Z0pp0aprysDq0NLUX0NWrZ2Sklo2NAfz+UxngLCY5YrKjCMnTi6UZ6emKXieqhmdcovHDcmfkM7CKpfC9VfAGxasCFXg1wEHGdYkFOf8NB7tDTI2Uc7rfwsluCwvTZtpbtTQ358pAjamhQg5Wq3g8bcB5VofrvBbvlUWeX+xWKyP7qpHp4UKGe7IZ68vi9KAe130nQW8fPncXPiGx942c7lext2ZksEtDdXUqOZp35Og+SbdhhSWPirosalvz6RzU0z9YwfBQFQN9BmanW/G5zwj5nXwTfhIpJCJkSsSjRZf9hQkWjUaU01fV3yreV50sqINXXBj9PwWsal6pfPG6R/wK3+ZTyI3PdcjSbB1fx0q4P+/ieEcAW0t7m46W1gJaW/MlCOtfK7g7bMB5UsfjsZGH4yoeTky4Lpvw3nZwuFXLxkIFm0uVnOxbcd11ywHK7xHUg+uhjfvLeq6OLWwu1uBoyScn/zdScn4nS/eFnNJkGShXUpNBeW069t4Segf09HQX0d9TLHvU0d40Id8VkZCbUFA4vhN8BQLUqA5WgI1KZLxqeFYFr6x5vQVsfFo8iBLIKAkeofgDfjcB3znXZzOszFZxvteI66qXy6MuFqbqaGsuwNqQT5MtX86Evo6UcrFj5W6/lrt9Azf75TjP6wg82Al5RUhnv3QHCpBD3mG5eiDI7xnC7ezGdd8u177ODuqZnazEaEonJec3Pmb+RkrBZ77kvyenLIUycy5lpgyaO4tpdWjp6y1mbsbE1Eglawt2zo/nCPivCIl9D2KDh1iBjTMn5bvKMFRF96pB1/HAqhMFFVjlOiHE6J8BVgk3UjZ3BAIPrK/2s77UxOlOg5xa+u8GOdpuY2qkik5HCdYGDRbhlLHl0ePIY3vByOW2mdvdSq53y/FcNeC7txMQC4fXHfhu2/Hfd/Fw28PdbR83171cXXbhdA5wd9PJ7Xkre1v19PaWUFD6mQ8Zv/CPlH/wOf8Tv2f+wqec38ks+kJW0QcqajOpbczG0VFAT3chk6MGjvf62NnsZ3V9hJOLHbmGp4KlWD3KO4olfWXlRBnQXkisxERZfFRVgYrTD4FNzItvSTkDC4UIhv3s7S8yOWrmdF9ECHbgvnRwf9rJ2pyJ/s5C7K1arI0aLEJqhf+gMVMuXYvp5958EWfreq4OTCxPa1ma1rG7WsXGXBl76zVMjRfT0pKKpe4Tzc2pTM9UcnbWxcJ0BQM9BdjaCsgofM/fkv7Kr5nvySjL5GPeBz7mfOAfSX8hWfM7uuo0SqtSaGzR0tlVgsNRwMJcI5MTFsZnWphbHeHOeSOjeELqdD3uPRU7V5Xm2CquohpiMW7xqvJ/GlhBIlLa5bllZqaLjdUWLo7sPFw4eLzo4OqondX5OjocWuosmRjNWdTbCqhtyKXemkmnPZfpgQL2Fyo4XqlgZ7GMif50CezCRAFTA7mM9+XR25VLs034ad9hrP6AtTGdpRUbczO1DA5WUNdSKJfW/5byK+/zkvkt6wPvsj/wc8qv/JzyC++zfyVHn4K+Ng9TYwH1zTpaHMX09Bno7K2gfbAGe389kwuTPPi8BCJPcvNz7B1DitRGQZXh/3HB1yqpWKl5/0vARsIBLq72WFsd4PZilIfLPi6P7RztNrO1ZqO3p5imVo20KUWAcFFFMpW1mdTUZWC1pDPUWcDiSAm7c5UsT+g42TZzvm/haMvM3kotm4t1rC1ZGegrYqC3iMGBMmytGtq79fT2V9HYWoy2MoP3Oe/5j/d/47+S3vO3lHf8JelX/vL5V35N/8AnzRd+z/qdZG0SadovaMrS0JYmUVWXS6UlTwbMFdbkY3bUM7O2iCscxBsUe3XF4KW8pxyk4iQ4ESsB/jNOauxWInivAxsTcXXgEhQIuDk4XOToYJyrkwF21xr4OqFnfLgUhz0fsyUDU0MOVZYcSqvTydW9l13S0pRHrTlNOq8nuwulO3F/uYa7YxunOybGezLoakqmvTENmzWFrvZ8pscrGR020OIoolqAYs6hyJDBh+zf+S3rI//x4Rf+48Ov/CP9M39J+p2/Jr/jr8m/84+03/l/P/+Nv6f8yrvM9yTnfZSWQ0l1toypzTdkUGzRUdZQibm9iYWdDVwhoRKiu8m/06kvr5/xSojt+mNgpW4RacoGOqFvRFcRdHC4zexMJ2fHY1wcdHO01UxHaya15s9UGD5iMKZQUZNKhSmDQv0XSipTqDRnYKrLwGJKocmUxFBbHovDpWzOGvBeduA6b2Zv2cBIZzY9Lek01X6gpz2blQULvV1FVNekU1GTjUFEFZamyQFLAPj//PJX/tvHd/wl+YME9mNeKv/1+Wf+891f+O+f/s4/Un7jY/YnPue8J1+fTn5JKjm6JPLLM9BW55FtyCPPWIypvYUz5yNeGZzySi+Nm+LGg63ipaxSh74HVj2PSWoMWMVu+ya3Hgmamx9ndbmX3Y0Obo97uTpoZ2utUem6A+U02fKwNOZQ35RHtTmTypp06hpyaGnJY6S3iLEuLYMtmYw5spnoyuFozcT9USOXexbuT9rlquzBhpWl2UpGB4ppbc7F0pCHyaql3JxHRmESv2W847fsJP7zw2/8t0/v+DnjC79lf+FvKb/xPvsTv2W8J0mTQmZJFhpDHjpjPtqKTEqq8tBVZMvzrNI0siqySS3NQWsyML+3g0fo16Cy2zJeUpXfGDavSazQsz+9ap+9aJGYbacay/5gkKOTQ+YXRllf6eLrWDXX+x2cbtk43Wvj5ryf2/NhLo4H2VpvY3LcKDd0NFqzaLZlM9BTyOm2jb2FKlbHdQy2fGGoNYVhexrzw3ncHDTiv+nDc9XH2a6NiYFCWpoyqK1NRW/4jLlRg6Eun5ySVD7lfuLn9A9Sv/4l9SN/T//Ar1mfSNGlkVueTX5FDnn6THLLMsgtS0NnzCJT9xFNaRq5RSkUlGeSXviF1OJ0Ukqy0ZgNtI0Oce8PEhBhVTK8M15yo0KWAG6igL4CrHKeKOriVyhuEZ91e38tHcX9vQ2MDxpZHK9mf8nC5mw1eysWdlYs7K80cbnXxf3ZIGd7XeyutbEwZcZhy6K/PZu9RQNXWzXcH9SyO1fEZGc64x0ZjHel83Uwj4tdG4frVlZnKrE3pmK1pFFvzaayRuznyqKiNp/CqhwySzKk/vwl4xN/SRb69hOZZdlklWaSWZxCYWUWZaZ8dJXZlJnzKa3Npaw2D70pn2JDNvlCWotT+KJN4l1uEr9mp5KsK2ByeRWPCAKMYqJuD/gzwIpfBdg46XwLWEXMIwTDXs4udiWoI/21LEzUsrvUwPJouRyEjlbrWRnXszlZxclyI5dbbVzttHO01szZlp2FUQNrUwaOlsq536vCe2bmarucr73p9Dd9YLwzjZGODKb7tSxOGJgaLMVhy6ZOxNNacuSGudKqdAoNGZSYtGQWp/E59zM/p/7O35N/JaUghYKqfLSGHIqqcqmoFQHHOvTGPEqNuRQbs9HXaeS5ALfQkIWuOo/kgmQ+5KdIYL8UaKmytXHtjeCX7sF4qyAW+R0Txlcl9mW3V1tFOhqi/kfhZxRLGJGwj5u7Q9Y3Rlme72B3rZPDdQdLo5US2O2Zag4XzayNlbI7Vc3etJGzlQYe9tpxn/TgOunhbLOZ691mbnZquNutwHdRg/fMyPlmOSvj+Ux0p9HZ8IF262c6benYLKmYq5Mo039Cb0iltDIdrT4FXXUOKQUi9jZZxuAma5IoqMzHYC3G2FhKdUMxtbYyqi1aTNYCSiuzKKnMptSkgJtZ8IESUUbeO7SGbJI0n/mYlxTV0Vmkl1Ywtb7LnTeEy6OEeMb3XmU6+1J1/gDYeHBjBSi7t4N4PJfMzXcyP9fM0W4vu6utLE3UsDNfz9aMke2ZKs5WLdxsNnEwY5S0PVnByXItj0d2fBc9eM578F104Tpp4PGomocjPd7LalznZh5OaznbqWZ2JIfOli90tmTQZFViBCqNGZQbs9BVZpCrTyW7PJ3kws8yWrvQmEuBIRNjQxENjgpsHQaq6zRYbMXUNmiprs3BaNFQXJmBriqDAkO6PC+pyiKnOJnk/A98yf1AsjaF3zKT+DkzjXdaHYV1TWycXOAOCl2reLUkLupK9TO40eXxOJX6CrDRFogWoji2g7g91+zuzkhQN9fbONx2MD9exVR/GTsL9ZxvNHOx0cTBvBHXgYOLZSsHszUs9hdwsGDkeqcR30U3/ut+PGfteM6aeTgy8XhSie/ahPvSRODBhu/OxvmBmZlRLV32TJobMzGbMySwFaZctBXpFJpyKTALEymDUmsh5dZCquoLaLDr6Rgw09JVSW2jjsa2MoyWPCprs6WkFxnSyS7+RL4+hfySJPKKk0jTfJRhprml6aQWJPOPtPf8V8on/is9k48FxTT2DHDjDuAX/lrpyVM2t8QDK6U1EdhnyYwjqVMlsMJeDfHoupFrRTNTLawuNrOx1MDKXB2TQ2XMjVWyNmOSXfxkrYGz9Uaut1u4WG3kcL6W6e58vg4UsDVr4HrHhue0C+exA++ZnYcjK3eHNTjPzLgu6/DdNhB0thB0tnN71sruej1fp4y0NudTUZkiwZEb5cx5aMRumHoNhuYSKpuKaOutwd5bg62zikqLlqr6QvlbWZ+PwZJHQYXYD6EhvzyFkppsKupEno4ykwZ9bSElJo20ID7lJ/PX1E/899QUfs7OJc9QzcreAV5/bPOH2pNVyZXgPgMbpwpUMNWblF8FWF/Ax9TsCIPDTQwN1rAy38TWio3J4XLGBkrlZuHxXh0zA8V8HSxmZaKCh8NOnAddHC7UszBcylhnHiNtmaxPlHO21sDJikWqBs+ZA99lK86zBu5Oank4r8N/34z/vo2gjH8d4vK4h9kJE02NeZgtuTS2l1PTUoTemkdVsw5DYyFVjTrqWkoxNRVhai6h2Ch8sXnklaVSLPyy5hyyS5LQVWVRKlyJ5lwqLAVU1hdJqmooodxSKG3crLIcPmoy+Dkrnd/zctEYjQx9nePRK6a5Kk7RMM8osC8l9hnY2ID1ItpOnke4ebimf7id/sF6BvqqmRw2sTpnY2qkmuHeEoZ7dYz0FrA0XcX8WDlzI6Wcib0Fex1cbdvZWxRWQhVf+4uZ6S7kYL6O05UGjpYteM+78V114rpo5fGsicczK9eHJu5O6nm4aOXmxM7uaj3jAyV0Owpw2HW0d5fT3FFGY0cpVdY8bF0GKa3GBh1l5jwpvZoqsblDK7cjJWvfkyM2MRd+psiYS1FNFoVV6RQZc6hqLMZgLaKiXkepWUOZRUdGSRa/ZH7ib2lf+DU7nU/aXMostRxd3sTs2vjAZHVF5XlVIW5Kq0ipQgJkqUcCEekWXFybx+aopaPTyPCAiYlBE9MjZvo7Sxnp1/N1spLJkRKGujUymmW8t5C1WRPb8xb2FqysjFezM1fPxlQNE+0aVkcNbE4b2V+wcLPv4OGkHc9lJ54LB86zZs63azhYNbA5r2dutJCxnnxGugsYG9DT1VFEm6OYjl4DvSMmrG1FNLXrae0xYmwqwthchsFWjKG5lLzKLDnApZd8obhOQ2F1DiWmfAmssGX19VrKLFoKKjMorslBZ8yWg2BGcTq/ZLznfW4a7/My+KjJJFtfxPLuHvdu8Z2w6IeCEr/QIaRWWFEqsCr68RKrTATC3D7eUt9SS2OrkXZ7NetLPawvtrM43cBAl57xoUoWZowsz4kFwxz62nPllqKvowamB/R8HTYw01fG3ICe1bEqNqaMLI8ZWBjRszBawdq0kYvdFm4OWrk/bMN73onrzMHtYQt7S0Y2vlbydaxM6vPluUbGRmpobS/G2lpAXWshVkcJFnsp5pYSDFYd1c1lVLWWYXSUK/q3pYRCoQpqBaA5VDUJ1VGA3pqPwaajxl5KUU0GJWYh4dkUmXPJq8jic/4X/p76jl8yP/Nzxgey9AXU2e0cX93KbymqO8bjx6eYuaXQT2KVUiTEB2EI88of9DG3NE11XSktdiO9nWYWpx1sLHawPGtjpK9K6tv15XpmxkpZmDIwOVTCcI+O/o4CGbAx3qtndqCC2f4yJrsKWZus5mCtkfU5MzNDeqYHS9mYM3G5Z5fSe3/Uyd1hJ3dHXews1rIyXU1/p5ZOh5bWlgLaHKVUW7KprM+hslFDdbOOsro8KhsVUCsaS6hq1UtLoVikNxdR0SB0ZzaVDYWYWksksFVCRzdo0ZkyMbYWUlCdQr4hiSJzNlphgpVl8DFbTDre8Xv2B9JLRePUcHh1jcunfGcx0X34HbBiwSy2T1/9eEMIt/eO9s4GrE16WtsqcDSXMz5Qz9exBqaGzUyPWthYbmNrVXEVCsmaHdUz0lcs17V6HUVMD1cz1a9npEMrAzfmRys42LRxftgppXCoW8fEQCkrMyZ2Fxu43OniaN3O+W4Ph5sdzE3VyaDlplYdFlsRxoZCqgUwzTq0xmzyq3OkZ0pTlYe2RkNJfREFNfkYW8upbi6m1l6GubWc+vYqrB2VmNtKqbQVSEmt66yg0qajolFDkTlTUkG14kvIK0vnS/ZHvuR+IbUolfTSLHL0OiaXF/GIHUNiv4I6UEW7vgrsc+yWsM0UYGPOBrG57PL6ALujhrY2sWZfSq+jgrE+E+MDRga7K5gdr2d9qYXNFcX7tDhlYGakjKEeHe0tuXQ7Culv1zHcpZNxrcJymOgvZnnOxPFBJ8cHPawtNjHaX8ZARyGzw9UcbnSxs9rO3kY3k8Nmujv0NLToMDUVUtWgo6JBR4lFg6Y6m08Fn0kry5KO7C8FyWRX5lJkKSKnPAONIUPuAi83K9PWEmMe1nYDNbYi2fWLhK+hsYCSulx5nm9IprQumyKxydmcg742H01ZFnmlWeQZctDWFJBr0FHX3srJzQ1+Ecyh2v9vARszsZRgYkHhkI+z0w36e80M9FbS31XKRH8VG4utrC81MzdTx8JsA18nTSzP1cgtRsszBim106PlDHQVSGkUYevjfcVy8BG6d1D8DpUxOVbFwqyVva0utjccfJ2spaejhJkJC5NjtUxPWJmaaKKjs4oGYeQ36eRAIwAVUppdmcPnwjQ+aFP5qEnhfd4XCXJSYRI5+nQ5bW1w6KlvLZGzsUpLISZbiZR2Q0M+lTYt1S1FlNXnk1uRQp4hBW1lurQWiqszpOespCqX0hotpRYdBWYdhbUVlFlrmdvcxhkQn8JSN2wrQMbbtYKe7VjBoK7nhINejg6WGOw1MTlqYrCrmPkxE3urdva32llZbGRmwszCbB2bq1bWl0xsLJlZmhHmmJ6BLhFsoWNxuobpkXIpxX1dBfR0FtDZUSBH9/HhGjZWHKwutzA6XCV1aGeXXo76jbYC+vrrGBhqxN5npr7DgL6hkEx9Khn6dJKL0vgl+zO/ZH/h95wvEtzfst7zPucdJaY8LK2lWFqKMZhyqLQUUNtcRn1bOXVtpRhtWiztpeiMGWir0iW4hTVZUg9rylOpqMulpqGA2ibRKMUUmzVojBryq4vJ1hdjarVzcHmLzx8VxOe4gqhVEI1YjAH7LLVCgn0c7C0wOmhhsKec4e4SdhZaONno4mC7i+WFJlYXW9nZ7GBhzsTmupWvkwZmxioZ7iujv6uYmfEaFmctDPQW091ZiKNNQ7tDR1NTPk2N+fR1V/J1qoGJMSMDA3qGho20tpdQ26RBX52B0VzAwEgz9r5aGsRsqrkEbU0uKcUpEtiPmlRpb37WpvEpP4kkbRI5ZWlykiAkVUx/xeeihMSaJEg6zLYiLG3FNHVVoK/LJU+fLCcQgvLL0ygwCGnVYLXraWzTY24spqxWS5G5kCx9Pu+z00nVFrK4tafYtAHlu2ICWHVzx7MqiI1mcSNcJMj25izD/fX0dlSwNt/K9cEYxxv9HO8Ns7bcwdK8g8O9Yfb2utnatLO23MLiVxtTYxamxq2sLDpYWbLLJebOrjKamwuxWjVY6rXUW7T0dtXwdbqF6al6llfsbG4P0Dtgxlivpag8ndKKHMqrtJRW52NsKqOmpYLSOh055TnkVuSTVpTN57xUPuYkkVmcJbd4mmx66mylGGryKCrPJL8olep64eUqx9JcTo21SIJlbdNLwDX6NOmnzS1JQVeZQ3FVLvVtBvrHmrHZK6m36eX9FZZS0nVZfM7N4FNWFrW2Vm4fRGxtdCt9wkcj3wwxEmGZLuclF+ebnJ0s83Czifd2B/fNNs478aGwHR7udvG6D/B6dnA+bOC83+Lhdou7m21urrZ4uN/l9naL65s1zi9XODpe5PBokf2DBY6Olzk7XeP6ap3LqyVu79Zwuva4vNnk8GyZrYN51ra+sr2/zPreIqt7C2wcrrBxtMbq/gprB2ss765IWtlbZvNolb3TdY4uNjg4WeHgZJXdw1U295fYP9tg/2yd3eNV9k/W2T9eZftggcPzdXaOltjYm2frYImDs022D1c4utzm/HaPY/HuVzvsn66xf77F1skWK/sbbBzts396is+vfB9RjS5UwVV30bwAVp3OKl/JFB/7cvIUfuQp/EAkID43+iA/NxqR9CDTnyJ3PEXEZ0jvFN7QI0HBG3Hy7clJOHwvKRS8l+kiakZsCQ0HH5RywjdEIjdEwneEww8Ewvf4gvf4Ag/4RTxY2I034sYTUsgb8UTPPfjCXvwREQvgJvTkIvzkJBh6JBR2EQx75P2BiEuSPyTS3PiDjwRCToIRJ/7wI77gYzRN8HlkWf6wU/Io9CivfU9e3CEfvkgIn/jqZ3TQV3cmxlTBM7DCbIiOaM8higq43+RXicXIJz6UK+xd4ez28xQR33qNpskP6AaV6xcUknEHSr7yAV3x2Tt1J6TIV9JFOSJdXItnCRtR+fCuqKD6aRAhCWJZSHzNIhSJ+x5s9EMMwrWpPkf5YK/SJcWWVuUrymLio5YryggSjn4dQ5Lc+ip0pnIu+GSZ0S8wi+fLbxFEQ+kVUyuKXfS7W/Hf2/1JDSRWv1qkfv4z0amrFqQq52c/5AuJF5IuWlJpzWfbLuqGVGclz7o87v7YWlLMphbPiIX4xKwX1SyML0M9j1dpKsnnx+eJckUokfwV4L9cDUgs6+V7xr1DAh7x1z+99ITH/IyJFXm+juN9+cBoWpRilVLAUALGotHQb1Y4Cmqc90h2ubiXjtnbLxtPPY/xxVygIj3+WvI825xxwMTVW6X4Or4E9ns84q9fAhtn4D4XJv/0SCz9RV4cxRonKqHRNDUwVxwxh89LUFTe+BcV52qX+57ndYo98yW/sC2l1Atgnuuq5ke/PP+D8tX7FJ5E+v75gn56gbg8V5ZjBJP8Gy/ik+NPYvPt9yS/1h6lcOQlKRt4lb37kr6Jv0+gdL/4Ciuf+lAoJL7tFVe+4FfzlO/WfF8X9R6VT/xplRdlxOWpz5DnUWCe/5JIQr6sa/R+8Y0HJe8lxdJiz1Dr8xJYCa6QFvFACH0D/xN4I+D7pvz6v0EAJf018oqAjui5uCee1HJEXuAJgtFz3xN44sj7yr3x5avPSOSRz4imq89KzJP5gsLfJIn3EXmJz5f3x9VF/VV5EstOfM7/AChIFm2USn2WAAAAAElFTkSuQmCC';

function b64ToUint8Array(b64: string): Uint8Array {
  // Workers-compatible atob
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function generateSuratPindahPDF(data: {
  letterNumber: string;
  letterDate: string;
  nama: string;
  alamatAsal?: string;
  alamatBaru?: string;
  lingkunganTujuan?: string;
  stasiTujuan?: string;
  paroki?: string;
  penandatangan?: string;
  perihalSurat?: string;
}): Promise<Uint8Array> {
  const {
    letterNumber, letterDate, nama,
    alamatAsal = '-', alamatBaru = '-',
    lingkunganTujuan = '-', stasiTujuan = '-',
    paroki = '-', penandatangan = 'Ketua Lingkungan',
  } = data;

  const formattedDate = (() => {
    try {
      return new Date(letterDate).toLocaleDateString('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch { return letterDate; }
  })();

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);

  const fontRegular = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold    = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  // Embed logos
  let logoLeft: Awaited<ReturnType<typeof pdfDoc.embedJpg>> | null = null;
  let logoRight: Awaited<ReturnType<typeof pdfDoc.embedPng>> | null = null;
  try {
    logoLeft  = await pdfDoc.embedJpg(b64ToUint8Array(LOGO_LEFT_B64));
    logoRight = await pdfDoc.embedPng(b64ToUint8Array(LOGO_RIGHT_B64));
  } catch (_) { /* logo opsional */ }

  const { width, height } = page.getSize();
  const mL = 50, mR = 50, mT = 45;
  const usableW = width - mL - mR;
  let y = height - mT;

  const tw = (text: string, font: typeof fontRegular, size: number) =>
    font.widthOfTextAtSize(text, size);

  const drawText = (text: string, x: number, yy: number, font: typeof fontRegular, size: number, color = rgb(0,0,0)) =>
    page.drawText(text, { x, y: yy, font, size, color });

  const drawCenter = (text: string, yy: number, font: typeof fontRegular, size: number, color = rgb(0,0,0)) => {
    const w = tw(text, font, size);
    drawText(text, mL + (usableW - w) / 2, yy, font, size, color);
  };

  // Word-wrap: returns array of lines fitting maxW
  const wrapText = (text: string, font: typeof fontRegular, size: number, maxW: number): string[] => {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const cand = current ? current + ' ' + word : word;
      if (tw(cand, font, size) <= maxW) { current = cand; }
      else { if (current) lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [text];
  };

  // Draw justified paragraph, return new y
  const drawPara = (
    text: string, x: number, yy: number, maxW: number,
    font: typeof fontRegular, size: number,
    lineSpacing = 1.5, firstIndent = 0
  ): number => {
    const lineH = size * lineSpacing;
    const lines = wrapText(text, font, size, maxW - firstIndent);
    let curY = yy;
    for (let i = 0; i < lines.length; i++) {
      const isFirst = i === 0;
      const isLast  = i === lines.length - 1;
      const xi      = x + (isFirst ? firstIndent : 0);
      const lMaxW   = maxW - (isFirst ? firstIndent : 0);
      if (isLast) {
        drawText(lines[i], xi, curY, font, size);
      } else {
        const lWords = lines[i].split(' ');
        if (lWords.length === 1) {
          drawText(lines[i], xi, curY, font, size);
        } else {
          const totalW = lWords.reduce((s, w) => s + tw(w, font, size), 0);
          const spaceW = (lMaxW - totalW) / (lWords.length - 1);
          let cx = xi;
          for (const w of lWords) {
            drawText(w, cx, curY, font, size);
            cx += tw(w, font, size) + spaceW;
          }
        }
      }
      curY -= lineH;
    }
    return curY;
  };

  const bodySize = 11;
  const lineH = bodySize * 1.5;
  const tblIndent = mL + 30;
  const col1W = 95, col2W = 15;
  const valX = tblIndent + col1W + col2W;
  const valMaxW = width - mR - valX;

  // Draw table row label | : | value
  const drawRow = (label: string, value: string, yy: number): number => {
    drawText(label, tblIndent, yy, fontRegular, bodySize);
    drawText(':', tblIndent + col1W, yy, fontRegular, bodySize);
    const valLines = wrapText(value, fontRegular, bodySize, valMaxW);
    for (const vl of valLines) { drawText(vl, valX, yy, fontRegular, bodySize); yy -= lineH; }
    return yy;
  };

  // ── 1. HEADER KOP ──
  const logoH = 45;
  if (logoLeft) {
    const s = logoH / logoLeft.height;
    page.drawImage(logoLeft, { x: mL, y: y - logoH + 5, width: logoLeft.width * s, height: logoH });
  }
  if (logoRight) {
    const s = logoH / logoRight.height;
    page.drawImage(logoRight, { x: width - mR - logoRight.width * s, y: y - logoH + 5, width: logoRight.width * s, height: logoH });
  }
  const blue = rgb(0.267, 0.447, 0.769);
  drawCenter('PAROKI ST. FRANSISKUS ASSISI PADANG BULAN \u2013 MEDAN', y - 9,  fontBold, 10, blue);
  drawCenter('STASI ST. PAULUS PASAR BARU',                              y - 21, fontBold, 9);
  drawCenter('LINGKUNGAN ST. AGATHA',                                    y - 34, fontBold, 11.5);
  y -= logoH + 5;
  page.drawLine({ start:{x:mL,y}, end:{x:width-mR,y}, thickness:2, color:rgb(0,0,0) });
  y -= 3;
  page.drawLine({ start:{x:mL,y}, end:{x:width-mR,y}, thickness:0.5, color:rgb(0,0,0) });
  y -= 18;

  // ── 2. JUDUL ──
  drawCenter('Surat Pengantar Pindah Lingkungan', y, fontBold, 13);
  y -= 13 * 1.4;
  drawCenter(letterNumber, y, fontRegular, 11);
  y -= 11 * 2.2;

  // ── 3. PARAGRAF PEMBUKA ──
  y = drawPara(
    'Yang bertanda tangan dibawah ini, Dewan Pastoral Lingkungan (DPL) St. Agatha, ' +
    'Stasi St. Paulus Pasar Baru, Paroki St. Fransiskus Assisi Padang Bulan - Medan ' +
    'dengan ini menerangkan bahwa :',
    mL, y, usableW, fontRegular, bodySize, 1.5, 28
  );
  y -= lineH * 0.4;

  // ── 4. TABEL NAMA & ALAMAT ASAL ──
  y = drawRow('Nama', nama, y);
  y = drawRow('Alamat Asal', alamatAsal, y);
  y -= lineH * 0.4;

  // ── 5. PARAGRAF TENGAH ──
  y = drawPara(
    'Adalah benar warga/umat lingkungan St. Agatha dan berstatus sebagai umat Katolik yang aktif ' +
    'beribadah di gereja Stasi St. Paulus Pasar Baru.',
    mL, y, usableW, fontRegular, bodySize, 1.5, 0
  );
  y -= lineH * 0.3;

  y = drawPara(
    'Sehubungan dengan umat yang bersangkutan telah pindah tempat tinggal ke alamat baru di ' +
    alamatBaru +
    ' dan telah bermohon kepada kami untuk pindah lingkungan, maka kami DPL St. Agatha mengeluarkan ' +
    'surat pengantar ini bagi yang bersangkutan dan seluruh anggota keluarganya sesuai dengan yang ' +
    'tercantum pada Kartu Keluarga Katolik (BIDUK) terakhir dalam rangka keperluan administrasi ' +
    'pindah lingkungan dengan tujuan:',
    mL, y, usableW, fontRegular, bodySize, 1.5, 28
  );
  y -= lineH * 0.4;

  // ── 6. TABEL TUJUAN ──
  y = drawRow('Lingkungan ', lingkunganTujuan, y);
  y = drawRow('Stasi', stasiTujuan, y);
  y = drawRow('Paroki', paroki, y);
  y -= lineH * 0.5;

  // ── 7. PENUTUP ──
  y = drawPara(
    'Demikian Surat Pengantar ini kami buat dengan sebenarnya untuk dapat dipergunakan sebagaimana mestinya.',
    mL, y, usableW, fontRegular, bodySize, 1.5, 28
  );
  y -= lineH * 0.2;
  y = drawPara(
    'Atas perhatian dan kerjasama saudara, kami ucapkan terima kasih. ',
    mL, y, usableW, fontRegular, bodySize, 1.5, 28
  );
  y -= lineH * 1.5;

  // ── 8. TANDA TANGAN ──
  const signX = mL + usableW * 0.62;
  drawText(`Medan, ${formattedDate}`, signX, y, fontRegular, bodySize);
  y -= lineH;
  drawText('DPL Lingkungan St. Agatha', signX, y, fontRegular, bodySize);
  y -= lineH * 4;
  drawText(penandatangan, signX, y, fontRegular, bodySize);

  return pdfDoc.save();
}

async function processDocxTemplate(
  docxBuffer: ArrayBuffer,
  placeholders: Record<string, string>
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(docxBuffer);

  // Temukan End of Central Directory
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
      eocdOffset = i; break;
    }
  }
  if (eocdOffset < 0) throw new Error('File bukan format ZIP/DOCX yang valid');

  const view = new DataView(docxBuffer);
  const cdOffset   = view.getUint32(eocdOffset + 16, true);
  const numEntries = view.getUint16(eocdOffset + 10, true);

  interface ZipEntry {
    name: string; compressMethod: number;
    compressedSize: number; uncompressedSize: number; localHeaderOffset: number;
  }
  const entries: ZipEntry[] = [];
  let cdPos = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(cdPos, true) !== 0x02014B50) break;
    const compressMethod    = view.getUint16(cdPos + 10, true);
    const compressedSize    = view.getUint32(cdPos + 20, true);
    const uncompressedSize  = view.getUint32(cdPos + 24, true);
    const nameLen           = view.getUint16(cdPos + 28, true);
    const extraLen          = view.getUint16(cdPos + 30, true);
    const commentLen        = view.getUint16(cdPos + 32, true);
    const localHeaderOffset = view.getUint32(cdPos + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cdPos + 46, cdPos + 46 + nameLen));
    entries.push({ name, compressMethod, compressedSize, uncompressedSize, localHeaderOffset });
    cdPos += 46 + nameLen + extraLen + commentLen;
  }

  function getLocalFileData(entry: ZipEntry): Uint8Array {
    const lhOffset = entry.localHeaderOffset;
    const nameLen  = view.getUint16(lhOffset + 26, true);
    const extraLen = view.getUint16(lhOffset + 28, true);
    const dataStart = lhOffset + 30 + nameLen + extraLen;
    return bytes.slice(dataStart, dataStart + entry.compressedSize);
  }

  async function decompress(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter(); const r = ds.readable.getReader();
    w.write(data as unknown as ArrayBuffer); w.close();
    const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value!); }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  async function compress(data: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter(); const r = cs.readable.getReader();
    w.write(data as unknown as ArrayBuffer); w.close();
    const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value!); }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  /**
   * Fix utama: placeholder di DOCX XML sering terpecah menjadi beberapa <w:r> run.
   * Contoh: {alamatBaru} bisa jadi:
   *   <w:r><w:t>{alamat</w:t></w:r><w:r><w:t>Baru}</w:t></w:r>
   *
   * Strategi:
   * 1. Gabungkan teks dalam setiap <w:p> paragraph menjadi 1 string bersih
   * 2. Replace placeholder di string bersih
   * 3. Tulis kembali ke dalam XML dengan 1 run per placeholder
   *
   * Tapi approach ini butuh XML parser. Pendekatan lebih sederhana dan reliable:
   * Normalisasi XML dulu: gabungkan semua <w:t> yang bersebelahan dalam 1 paragraph,
   * lalu replace.
   */
  function normalizeAndReplacePlaceholders(xml: string, ph: Record<string, string>): string {
    // Step 1: Escape values
    const escapedPh: Record<string, string> = {};
    for (const [k, v] of Object.entries(ph)) {
      escapedPh[k] = v
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Step 2: Untuk setiap <w:p>...</w:p>, ekstrak semua teks dari <w:t>,
    // gabungkan, replace placeholder, lalu rebuild paragraph.
    // Kita gunakan regex sederhana yang cukup untuk dokumen Word standard.
    
    // Pertama: coba replace langsung (untuk template yang placeholder-nya tidak terpecah)
    let result = xml;
    for (const [k, v] of Object.entries(escapedPh)) {
      // Semua variasi penulisan: {key}, { key }, {Key}, dll.
      result = result.split(`{${k}}`).join(v);
      result = result.split(`{ ${k} }`).join(v);
      // Case insensitive: {ALAMATBARU}, {alamatbaru}
      const lk = k.toLowerCase();
      const uk = k.toUpperCase();
      if (lk !== k) result = result.split(`{${lk}}`).join(v);
      if (uk !== k) result = result.split(`{${uk}}`).join(v);
    }

    // Step 3: Handle terpecah — cari pola {... yang belum tertutup dalam 1 run
    // Regex: cari semua text content dalam paragraph, gabungkan, replace, masukkan kembali
    result = result.replace(/<w:p[ >][^]*?<\/w:p>/g, (paragraph) => {
      // Ekstrak semua teks di dalam <w:t>...</w:t>
      const textMatches = [...paragraph.matchAll(/<w:t(?:[^>]*)>([\s\S]*?)<\/w:t>/g)];
      if (textMatches.length === 0) return paragraph;

      // Gabungkan semua teks dari runs dalam paragraf ini
      const combined = textMatches.map(m => m[1]).join('');

      // Cek apakah ada placeholder yang masih belum tereplace
      let hasUnreplaced = false;
      for (const k of Object.keys(escapedPh)) {
        if (combined.includes(`{${k}`) || combined.includes(`{${k.toLowerCase()}`) || combined.includes(`{${k.toUpperCase()}`)) {
          hasUnreplaced = true; break;
        }
      }
      // Juga cek pola { atau } yang masih ada (tanda placeholder terpecah)
      if (!hasUnreplaced && !/{[a-zA-Z]/.test(combined)) return paragraph;

      // Replace di combined text
      let fixedCombined = combined;
      for (const [k, v] of Object.entries(escapedPh)) {
        fixedCombined = fixedCombined.split(`{${k}}`).join(v);
        fixedCombined = fixedCombined.split(`{${k.toLowerCase()}}`).join(v);
        fixedCombined = fixedCombined.split(`{${k.toUpperCase()}}`).join(v);
        fixedCombined = fixedCombined.split(`{ ${k} }`).join(v);
      }

      if (fixedCombined === combined) return paragraph; // tidak ada perubahan

      // Tulis kembali: ambil run pertama, hapus semua <w:t> lama, ganti dengan 1 <w:t>
      // Pertahankan formatting (<w:rPr>) dari run pertama
      const firstRunMatch = paragraph.match(/<w:r[ >][^]*?<\/w:r>/);
      if (!firstRunMatch) return paragraph;

      const firstRun = firstRunMatch[0];
      // Ekstrak w:rPr jika ada
      const rPrMatch = firstRun.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
      const rPr = rPrMatch ? rPrMatch[0] : '';

      // Rebuild paragraph: ambil semua yang bukan w:r, tambahkan 1 w:r baru
      // Hapus semua w:r dari paragraph, tambah run baru dengan teks yg sudah direplace
      const paraWithoutRuns = paragraph.replace(/<w:r[ >][^]*?<\/w:r>/g, '');
      // Sisipkan run baru sebelum </w:p>
      const newRun = `<w:r>${rPr}<w:t xml:space="preserve">${fixedCombined}</w:t></w:r>`;
      return paraWithoutRuns.replace(/<\/w:p>/, newRun + '</w:p>');
    });

    return result;
  }

  interface ProcessedEntry {
    name: string; compressMethod: number;
    data: Uint8Array; compressed: Uint8Array;
  }
  const processed: ProcessedEntry[] = [];

  for (const entry of entries) {
    const rawData = getLocalFileData(entry);
    let uncompressed: Uint8Array;
    if (entry.compressMethod === 0) {
      uncompressed = rawData;
    } else if (entry.compressMethod === 8) {
      uncompressed = await decompress(rawData);
    } else {
      processed.push({ name: entry.name, compressMethod: entry.compressMethod, data: rawData, compressed: rawData });
      continue;
    }

    // Modifikasi semua XML files yang mungkin berisi konten teks
    const isXmlContent = entry.name === 'word/document.xml' ||
                         entry.name === 'word/header1.xml' ||
                         entry.name === 'word/header2.xml' ||
                         entry.name === 'word/footer1.xml' ||
                         entry.name === 'word/footer2.xml';

    if (isXmlContent) {
      let xmlText = new TextDecoder('utf-8').decode(uncompressed);
      xmlText = normalizeAndReplacePlaceholders(xmlText, placeholders);
      const modifiedBytes = new TextEncoder().encode(xmlText);
      const recompressed = await compress(modifiedBytes);
      processed.push({ name: entry.name, compressMethod: 8, data: modifiedBytes, compressed: recompressed });
    } else {
      if (entry.compressMethod === 8) {
        processed.push({ name: entry.name, compressMethod: 8, data: uncompressed, compressed: rawData });
      } else {
        processed.push({ name: entry.name, compressMethod: 0, data: uncompressed, compressed: uncompressed });
      }
    }
  }

  // Rebuild ZIP
  const enc = new TextEncoder();
  function uint16LE(n: number) { return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF]); }
  function uint32LE(n: number) { return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]); }
  function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  function crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const localHeaders: Uint8Array[] = [];
  const centralDirs: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let currentOffset = 0;

  for (const entry of processed) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const compSize = entry.compressed.length;
    const uncompSize = entry.data.length;
    const method = entry.compressMethod;
    localOffsets.push(currentOffset);

    const lh = concat(
      new Uint8Array([0x50, 0x4B, 0x03, 0x04]),
      uint16LE(20), uint16LE(0), uint16LE(method),
      uint16LE(0), uint16LE(0),
      uint32LE(crc), uint32LE(compSize), uint32LE(uncompSize),
      uint16LE(nameBytes.length), uint16LE(0),
      nameBytes, entry.compressed
    );
    localHeaders.push(lh);
    currentOffset += lh.length;

    const cd = concat(
      new Uint8Array([0x50, 0x4B, 0x01, 0x02]),
      uint16LE(20), uint16LE(20), uint16LE(0), uint16LE(method),
      uint16LE(0), uint16LE(0),
      uint32LE(crc), uint32LE(compSize), uint32LE(uncompSize),
      uint16LE(nameBytes.length), uint16LE(0), uint16LE(0),
      uint16LE(0), uint16LE(0), uint32LE(0),
      uint32LE(localOffsets[localOffsets.length - 1]),
      nameBytes
    );
    centralDirs.push(cd);
  }

  const cdStartOffset = currentOffset;
  const cdTotal = centralDirs.reduce((s, c) => s + c.length, 0);
  const eocdBytes = concat(
    new Uint8Array([0x50, 0x4B, 0x05, 0x06]),
    uint16LE(0), uint16LE(0),
    uint16LE(processed.length), uint16LE(processed.length),
    uint32LE(cdTotal), uint32LE(cdStartOffset), uint16LE(0)
  );

  const all = concat(...localHeaders, ...centralDirs, eocdBytes);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

// ─────────────────────────────────────────────
// JWT Helpers
// ─────────────────────────────────────────────
async function signJWT(payload: object, secret: string): Promise<string> {
  const encode = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const h = encode({ alg:'HS256', typ:'JWT' });
  const p = encode(payload);
  const si = `${h}.${p}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(si));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return `${si}.${s}`;
}

async function verifyJWT(token: string, secret: string): Promise<any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const si = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(si));
  if (!valid) throw new Error('Invalid signature');
  const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

// ─────────────────────────────────────────────
// Generate Letter Number
// ─────────────────────────────────────────────
async function generateLetterNumber(kategoriSurat: string, tanggalPermohonan: string | undefined, supabase: any) {
  const date = tanggalPermohonan ? new Date(tanggalPermohonan) : new Date();
  const year = date.getFullYear();
  const monthRoman = ROMAN_MONTHS[date.getMonth()];
  const kodeMap: Record<string, string> = {
    PINDAH:'PINDAH', pindah:'PINDAH', KETERANGAN:'KETERANGAN', keterangan:'KETERANGAN',
  };
  const kodeJenis = kodeMap[kategoriSurat] || kategoriSurat.toUpperCase();
  const { count, error } = await supabase
    .from('archives').select('id', { count:'exact', head:true })
    .eq('letter_type', kodeJenis)
    .gte('created_at', `${year}-01-01T00:00:00.000Z`)
    .lt('created_at', `${year+1}-01-01T00:00:00.000Z`);
  if (error) throw new Error(`Gagal menghitung nomor urut: ${error.message}`);
  const nomorUrut = String((count || 0) + 1).padStart(3, '0');
  return { letterNumber:`${nomorUrut}/${kodeJenis}/SA-PB/${monthRoman}/${year}`, letterDate:date.toISOString(), kodeJenis };
}

// ─────────────────────────────────────────────
// CORS helper
// ─────────────────────────────────────────────
function getAllowedOrigins(env: Env): string[] {
  const origins = [
    'http://localhost:3000','http://localhost:5173',
    'https://arsip-surat-app.vercel.app',
    'https://portalagatha.com','https://www.portalagatha.com',
  ];
  if (env.CORS_ORIGINS) env.CORS_ORIGINS.split(',').forEach(o => { const t=o.trim(); if(t && !origins.includes(t)) origins.push(t); });
  if (env.FRONTEND_URL && !origins.includes(env.FRONTEND_URL.trim())) origins.push(env.FRONTEND_URL.trim());
  if (env.APP_ORIGIN && !origins.includes(env.APP_ORIGIN.trim())) origins.push(env.APP_ORIGIN.trim());
  return origins;
}

// ═════════════════════════════════════════════
// HONO APP
// ═════════════════════════════════════════════
const app = new Hono<{ Bindings: Env }>();

// CORS Middleware
app.use('*', async (c, next) => {
  const allowedOrigins = getAllowedOrigins(c.env);
  const origin = c.req.header('origin') || '';
  const isAllowed = !origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app');
  const corsOrigin = isAllowed ? (origin || '*') : 'null';

  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'X-Letter-Number, X-Archive-Id, Content-Disposition',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    }});
  }
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', corsOrigin);
  c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  c.res.headers.set('Access-Control-Expose-Headers', 'X-Letter-Number, X-Archive-Id, Content-Disposition');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
});

// Auth Middleware
async function requireAuth(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return c.json({ message: 'Token diperlukan' }, 401);
  try {
    const decoded = await verifyJWT(authHeader.slice(7), c.env.JWT_SECRET);
    c.set('user', decoded);
  } catch {
    return c.json({ message: 'Token tidak valid atau sudah kadaluarsa' }, 401);
  }
  await next();
}

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
app.get('/api/health', async (c) => {
  return c.json({ status:'ok', timestamp:new Date().toISOString(), env:{
    supabase:!!(c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_ROLE_KEY),
    storage:!!(c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_ROLE_KEY),
    jwt:!!c.env.JWT_SECRET,
  }});
});

// ─────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────
app.post('/api/auth/login', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message:'Body JSON tidak valid' }, 400); }
  const { username, password } = body;
  if (!username || !password) return c.json({ message:'Username dan password diperlukan' }, 400);
  if (username !== 'admin' || password !== c.env.ADMIN_PASSWORD) return c.json({ message:'Username atau password salah' }, 401);
  const token = await signJWT({ username, exp: Math.floor(Date.now()/1000) + 8*3600 }, c.env.JWT_SECRET);
  return c.json({ token, username });
});

// ─────────────────────────────────────────────
// GET /api/templates
// ─────────────────────────────────────────────
app.get('/api/templates', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const { data, error } = await supabase.from('templates').select('*').order('created_at', { ascending:false });
  if (error) return c.json({ message:`Gagal mengambil template: ${error.message}` }, 500);
  return c.json(data);
});

// ─────────────────────────────────────────────
// GET /api/templates/category/:kategori
// ─────────────────────────────────────────────
app.get('/api/templates/category/:kategori', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const kategori = c.req.param('kategori').toUpperCase();
  const { data, error } = await supabase.from('templates').select('*').eq('category', kategori)
    .order('created_at', { ascending:false }).limit(1).maybeSingle();
  if (error) return c.json({ message:`Gagal mengambil template: ${error.message}` }, 500);
  if (!data) return c.json({ exists:false, template:null });
  return c.json({ exists:true, template:data });
});

// ─────────────────────────────────────────────
// POST /api/templates
// ─────────────────────────────────────────────
app.post('/api/templates', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });

  let formData: FormData;
  try { formData = await c.req.formData(); } catch { return c.json({ message:'Gagal membaca form data' }, 400); }

  const name = (formData.get('name') || formData.get('templateName')) as string;
  const category = formData.get('category') as string;
  const file = formData.get('template') as File | null;

  if (!name || !category) return c.json({ message:'Field name dan category diperlukan' }, 400);
  if (file && file.size > 50*1024*1024) return c.json({ message:'Ukuran file melebihi batas 50MB' }, 413);

  let storageFilePath: string | null = null;
  let storagePublicUrl: string | null = null;
  if (file && file.size > 0) {
    const result = await uploadToSupabaseStorage(
      await file.arrayBuffer(), `${Date.now()}_${file.name}`,
      file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY
    );
    if (result) { storageFilePath = result.file_path; storagePublicUrl = result.public_url; }
  }

  const { data, error } = await supabase.from('templates')
    .insert([{ name, category, drive_file_id:storageFilePath, drive_web_view_link:storagePublicUrl }])
    .select().single();
  if (error) return c.json({ message:`Gagal menyimpan template: ${error.message}` }, 500);
  return c.json(data, 201);
});

// ─────────────────────────────────────────────
// PUT /api/templates/category/:kategori
// ─────────────────────────────────────────────
app.put('/api/templates/category/:kategori', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const kategori = c.req.param('kategori').toUpperCase();

  let formData: FormData;
  try { formData = await c.req.formData(); } catch { return c.json({ message:'Gagal membaca form data' }, 400); }

  const name = (formData.get('name') || formData.get('templateName') || `Template ${kategori} Updated`) as string;
  const file = formData.get('template') as File | null;
  if (!file || file.size === 0) return c.json({ message:'File template diperlukan' }, 400);
  if (file.size > 50*1024*1024) return c.json({ message:'Ukuran file melebihi batas 50MB' }, 413);

  const result = await uploadToSupabaseStorage(
    await file.arrayBuffer(), `${Date.now()}_${file.name}`,
    file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY
  );
  if (!result) return c.json({ message:'Gagal mengupload file ke storage' }, 500);

  await supabase.from('templates').delete().eq('category', kategori);
  const { data, error } = await supabase.from('templates')
    .insert([{ name, category:kategori, drive_file_id:result.file_path, drive_web_view_link:result.public_url }])
    .select().single();
  if (error) return c.json({ message:`Gagal menyimpan template: ${error.message}` }, 500);
  return c.json(data, 200);
});

// ─────────────────────────────────────────────
// DELETE /api/templates/:id
// ─────────────────────────────────────────────
app.delete('/api/templates/:id', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const id = c.req.param('id');
  const { data:existing, error:fetchErr } = await supabase.from('templates').select('id').eq('id',id).single();
  if (fetchErr || !existing) return c.json({ message:'Template tidak ditemukan' }, 404);
  const { error } = await supabase.from('templates').delete().eq('id',id);
  if (error) return c.json({ message:`Gagal menghapus template: ${error.message}` }, 500);
  return c.json({ message:'Template berhasil dihapus' });
});

// ─────────────────────────────────────────────
// GET /api/archives/dashboard
// ─────────────────────────────────────────────
app.get('/api/archives/dashboard', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const month = c.req.query('month');
  const year  = c.req.query('year');

  let lq = supabase.from('archives').select('id', { count:'exact', head:true }).not('letter_number','is',null);
  let uq = supabase.from('archives').select('id', { count:'exact', head:true }).not('drive_file_id','is',null);
  if (month) { lq = lq.eq('archive_month', parseInt(month,10)); uq = uq.eq('archive_month', parseInt(month,10)); }
  if (year)  { lq = lq.eq('archive_year',  parseInt(year,10));  uq = uq.eq('archive_year',  parseInt(year,10)); }

  const [{ count:lc, error:le }, { count:uc, error:ue }] = await Promise.all([lq, uq]);
  if (le) return c.json({ message:`Gagal: ${le.message}` }, 500);
  if (ue) return c.json({ message:`Gagal: ${ue.message}` }, 500);
  return c.json({ letters: lc||0, uploads: uc||0 });
});

// ─────────────────────────────────────────────
// GET /api/archives
// ─────────────────────────────────────────────
app.get('/api/archives', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const { month, year, jenisArsip, namaArsip } = c.req.query() as Record<string,string>;
  let q = supabase.from('archives').select('*').order('created_at', { ascending:false });
  if (month) q = q.eq('archive_month', parseInt(month,10));
  if (year)  q = q.eq('archive_year',  parseInt(year,10));
  if (jenisArsip) q = q.eq('jenis_arsip', jenisArsip);
  if (namaArsip)  q = q.ilike('nama_arsip', `%${namaArsip}%`);
  const { data, error } = await q;
  if (error) return c.json({ message:`Gagal mengambil arsip: ${error.message}` }, 500);
  return c.json(data);
});

// ─────────────────────────────────────────────
// POST /api/archives/take-number
// ─────────────────────────────────────────────
app.post('/api/archives/take-number', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message:'Body JSON tidak valid' }, 400); }
  const { kategoriSurat, tanggalPermohonan, perihalSurat } = body;
  if (!kategoriSurat) return c.json({ message:'Field kategoriSurat diperlukan' }, 400);
  const { letterNumber, letterDate, kodeJenis } = await generateLetterNumber(kategoriSurat, tanggalPermohonan, supabase);
  const date = new Date(letterDate);
  const { data, error } = await supabase.from('archives').insert([{
    nama_arsip: perihalSurat || `Surat ${kodeJenis} - ${letterNumber}`,
    jenis_arsip: kodeJenis, letter_number: letterNumber, letter_type: kodeJenis,
    letter_subject: perihalSurat||null, request_date: letterDate,
    letter_date: letterDate,
    archive_month: date.getMonth()+1, archive_year: date.getFullYear(), sync_status:'local',
  }]).select().single();
  if (error) return c.json({ message:`Gagal menyimpan: ${error.message}` }, 500);
  return c.json({ letterNumber, letterDate, id:data.id }, 200);
});

// ─────────────────────────────────────────────
// POST /api/archives/manual-upload
// ─────────────────────────────────────────────
app.post('/api/archives/manual-upload', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  let formData: FormData;
  try { formData = await c.req.formData(); } catch { return c.json({ message:'Gagal membaca form data' }, 400); }

  const jenisArsip   = formData.get('jenisArsip') as string|null;
  const namaArsip    = formData.get('namaArsip')  as string|null;
  const archiveMonth = formData.get('archiveMonth') as string|null;
  const archiveYear  = formData.get('archiveYear')  as string|null;
  const file         = formData.get('file') as File|null;

  if (!namaArsip) return c.json({ message:'Field namaArsip diperlukan' }, 400);
  if (file && file.size > 50*1024*1024) return c.json({ message:'Ukuran file melebihi batas 50MB' }, 413);

  let driveFileId: string|null = null, driveWebViewLink: string|null = null, syncStatus = 'local';
  if (file && file.size > 0) {
    const result = await uploadToSupabaseStorage(
      await file.arrayBuffer(), `${Date.now()}_${file.name}`,
      file.type || 'application/octet-stream',
      c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY
    );
    if (result) { driveFileId = result.file_path; driveWebViewLink = result.public_url; syncStatus = 'synced'; }
  }

  const { data, error } = await supabase.from('archives').insert([{
    nama_arsip: namaArsip, jenis_arsip: jenisArsip||null,
    archive_month: archiveMonth ? parseInt(archiveMonth,10) : null,
    archive_year:  archiveYear  ? parseInt(archiveYear,10)  : null,
    sync_status: syncStatus, drive_file_id: driveFileId, drive_web_view_link: driveWebViewLink,
  }]).select().single();
  if (error) return c.json({ message:`Gagal menyimpan arsip: ${error.message}` }, 500);
  return c.json(data, 201);
});

// ─────────────────────────────────────────────
// POST /api/archives/generate-pdf
// Generate surat pindah sebagai PDF
// ─────────────────────────────────────────────
app.post('/api/archives/generate-pdf', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message:'Body JSON tidak valid' }, 400); }

  const {
    kategoriSurat, nama, tanggalPermohonan,
    alamatAsal, alamatBaru, lingkunganTujuan,
    stasiTujuan, paroki, penandatangan, perihalSurat,
  } = body;

  if (!kategoriSurat) return c.json({ message:'Field kategoriSurat diperlukan' }, 400);
  if (!nama) return c.json({ message:'Field nama diperlukan' }, 400);

  const kodeMap: Record<string,string> = { PINDAH:'PINDAH', pindah:'PINDAH', KETERANGAN:'KETERANGAN', keterangan:'KETERANGAN' };
  const kodeJenis = kodeMap[kategoriSurat] || kategoriSurat.toUpperCase();

  // ── Validasi template ──
  const { data:templateData, error:templateErr } = await supabase
    .from('templates').select('*').eq('category', kodeJenis)
    .order('created_at', { ascending:false }).limit(1).maybeSingle();
  if (templateErr) return c.json({ message:`Gagal memeriksa template: ${templateErr.message}` }, 500);
  if (!templateData || !templateData.drive_file_id) {
    return c.json({
      message:`Template ${kodeJenis} belum diupload. Silakan upload template DOCX terlebih dahulu di menu Template DOCX.`,
      code:'TEMPLATE_NOT_FOUND',
    }, 400);
  }

  // ── Generate letter number ──
  const { letterNumber, letterDate } = await generateLetterNumber(kategoriSurat, tanggalPermohonan, supabase);
  const date = new Date(letterDate);

  // ── Simpan ke DB (termasuk semua field data umat) ──
  const insertPayload: Record<string, any> = {
    nama_arsip:    nama,
    jenis_arsip:   kodeJenis,
    letter_number: letterNumber,
    letter_type:   kodeJenis,
    letter_subject: perihalSurat || null,
    request_date:  letterDate,
    letter_date:   letterDate,
    archive_month: date.getMonth() + 1,
    archive_year:  date.getFullYear(),
    sync_status:   'local',
    // Data umat — disimpan agar tidak hilang jika file storage terhapus
    alamat_asal:      alamatAsal       || null,
    alamat_baru:      alamatBaru       || null,
    lingkungan_tujuan: lingkunganTujuan || null,
    stasi_tujuan:     stasiTujuan      || null,
    paroki_tujuan:    paroki           || null,
    penandatangan:    penandatangan    || null,
  };

  const { data:archiveData, error:dbError } = await supabase.from('archives')
    .insert([insertPayload]).select().single();
  if (dbError) {
    // Jika gagal karena kolom belum ada (migrasi belum dijalankan),
    // fallback ke insert tanpa kolom baru
    if (dbError.message && dbError.message.includes('column') && dbError.message.includes('does not exist')) {
      const fallbackPayload = {
        nama_arsip: nama, jenis_arsip: kodeJenis,
        letter_number: letterNumber, letter_type: kodeJenis,
        letter_subject: perihalSurat||null, request_date: letterDate,
        letter_date: letterDate,
        archive_month: date.getMonth()+1, archive_year: date.getFullYear(), sync_status:'local',
      };
      const { data:fb, error:fe } = await supabase.from('archives').insert([fallbackPayload]).select().single();
      if (fe) return c.json({ message:`Gagal menyimpan arsip: ${fe.message}` }, 500);
      // Override archiveData dengan fallback
      Object.assign(archiveData ?? {}, fb);
      // continue with fb as archiveData
      const { data:archiveData2, error:dbError2 } = { data: fb, error: null };
      if (!archiveData2) return c.json({ message:'Gagal menyimpan arsip (fallback)' }, 500);
      // Use archiveData2 for the rest
      const pdfBytes2 = await generateSuratPindahPDF({
        letterNumber, letterDate,
        nama: nama || '', alamatAsal: alamatAsal || '-', alamatBaru: alamatBaru || '-',
        lingkunganTujuan: lingkunganTujuan || '-', stasiTujuan: stasiTujuan || '-',
        paroki: paroki || '-', penandatangan: penandatangan || 'Ketua Lingkungan',
        perihalSurat: perihalSurat || 'Surat Pindah',
      });
      const safeNum2 = letterNumber.replace(/\//g, '-');
      const outFile2 = `surat-${safeNum2}.pdf`;
      const pdfAB2 = pdfBytes2.buffer.slice(pdfBytes2.byteOffset, pdfBytes2.byteOffset + pdfBytes2.byteLength) as ArrayBuffer;
      const upRes2 = await uploadToSupabaseStorage(pdfAB2, outFile2, 'application/pdf', c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
      if (upRes2) {
        await supabase.from('archives').update({ drive_file_id: upRes2.file_path, drive_web_view_link: upRes2.public_url, sync_status: 'synced' }).eq('id', archiveData2.id);
      }
      return new Response(pdfAB2 as BodyInit, { status:200, headers: { 'Content-Type':'application/pdf', 'X-Letter-Number':letterNumber, 'X-Archive-Id':archiveData2.id, 'Content-Disposition':`inline; filename="${outFile2}"` }});
    }
    return c.json({ message:`Gagal menyimpan arsip: ${dbError.message}` }, 500);
  }

  // ── Generate PDF langsung dari data field ──
  // PDF dihasilkan dari scratch dengan layout surat resmi
  // Semua data field langsung masuk tanpa bergantung pada placeholder di template
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateSuratPindahPDF({
      letterNumber, letterDate,
      nama:             nama             || '',
      alamatAsal:       alamatAsal       || '-',
      alamatBaru:       alamatBaru       || '-',
      lingkunganTujuan: lingkunganTujuan || '-',
      stasiTujuan:      stasiTujuan      || '-',
      paroki:           paroki           || '-',
      penandatangan:    penandatangan    || 'Ketua Lingkungan',
      perihalSurat:     perihalSurat     || 'Surat Pindah',
    });
  } catch (pdfErr: any) {
    return c.json({ message:`Gagal membuat PDF: ${pdfErr.message}` }, 500);
  }

  // ── Upload PDF ke Supabase Storage ──
  const safeLetterNumber = letterNumber.replace(/\//g, '-');
  const outputFileName = `surat-${safeLetterNumber}.pdf`;

  const pdfAB = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
  const uploadResult = await uploadToSupabaseStorage(
    pdfAB, outputFileName, 'application/pdf',
    c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY
  );
  if (uploadResult) {
    await supabase.from('archives').update({
      drive_file_id: uploadResult.file_path,
      drive_web_view_link: uploadResult.public_url,
      sync_status: 'synced',
    }).eq('id', archiveData.id);
  }

  // ── Return PDF ──
  return new Response(pdfAB as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'X-Letter-Number': letterNumber,
      'X-Archive-Id': archiveData.id,
      'Content-Disposition': `inline; filename="${outputFileName}"`,
    },
  });
});

// ─────────────────────────────────────────────
// PUT /api/archives/:id
// ─────────────────────────────────────────────
app.put('/api/archives/:id', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const id = c.req.param('id');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ message:'Body JSON tidak valid' }, 400); }
  const { namaArsip, jenisArsip, perihalSurat, tanggalPermohonan } = body;
  const { data:existing, error:fetchErr } = await supabase.from('archives').select('id').eq('id',id).single();
  if (fetchErr || !existing) return c.json({ message:'Arsip tidak ditemukan' }, 404);
  const upd: Record<string,any> = {};
  if (namaArsip !== undefined)         upd.nama_arsip    = namaArsip;
  if (jenisArsip !== undefined)        upd.jenis_arsip   = jenisArsip;
  if (perihalSurat !== undefined)      upd.letter_subject = perihalSurat;
  if (tanggalPermohonan !== undefined) upd.request_date  = tanggalPermohonan;
  if (Object.keys(upd).length === 0) return c.json({ message:'Tidak ada field yang diperbarui' }, 400);
  const { data, error } = await supabase.from('archives').update(upd).eq('id',id).select().single();
  if (error) return c.json({ message:`Gagal memperbarui arsip: ${error.message}` }, 500);
  return c.json(data);
});

// ─────────────────────────────────────────────
// DELETE /api/archives/:id
// ─────────────────────────────────────────────
app.delete('/api/archives/:id', requireAuth, async (c) => {
  if (!c.env.SUPABASE_URL) return c.json({ message:'Database tidak dikonfigurasi' }, 503);
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
  const id = c.req.param('id');
  const { data:existing, error:fetchErr } = await supabase.from('archives').select('id').eq('id',id).single();
  if (fetchErr || !existing) return c.json({ message:'Arsip tidak ditemukan' }, 404);
  const { error } = await supabase.from('archives').delete().eq('id',id);
  if (error) return c.json({ message:`Gagal menghapus arsip: ${error.message}` }, 500);
  return c.json({ message:'Arsip berhasil dihapus' });
});

app.notFound((c) => c.json({ message:`Route ${c.req.method} ${c.req.path} tidak ditemukan` }, 404));
app.onError((err, c) => { console.error('[Error]', err.message); return c.json({ message:err.message||'Terjadi kesalahan' }, 500); });

export default app;
