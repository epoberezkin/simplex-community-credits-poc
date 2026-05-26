// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract CheckpointVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 1318237846711027371591073401675008424604086347504510817666121530450756950980;
    uint256 constant deltax2 = 3101936456347742589440007364347553643548383009463299848946625117782054037512;
    uint256 constant deltay1 = 14352963914798486990408348624242181519705658473551185654302819223511645851387;
    uint256 constant deltay2 = 21079880953433237750761865300119219942248425812031108552367431756987712171805;

    
    uint256 constant IC0x = 10035221051408403698206834568960232799574661173892191301057302576032172758119;
    uint256 constant IC0y = 7196588531931211906780500969290557340187623986383922413667764231969857424912;
    
    uint256 constant IC1x = 10459383642775552924953365970525763353094274398914737429764033682644393482620;
    uint256 constant IC1y = 13407559453583162090093234404730212698188187925752814280244454921398427340311;
    
    uint256 constant IC2x = 14853561590877876859036731862280468313382036386921851670454724510687260957321;
    uint256 constant IC2y = 13898093006921421999385513291410550249055415604557577924866472904312210559453;
    
    uint256 constant IC3x = 14860485949379654923437899469817449295460512561789705059014001936362927401302;
    uint256 constant IC3y = 12673322704004639785865162536931577583955809513149855765250080249472689278153;
    
    uint256 constant IC4x = 10339454390806973758217825081766180280105676172671971340268365726638284249165;
    uint256 constant IC4y = 4833120343050085786505899481745943652124894129851998779300592109617075425911;
    
    uint256 constant IC5x = 12511328644353308043170658745016641077578944348358679054065753216770570525011;
    uint256 constant IC5y = 9881701032600772508093923254637521978419952623322218060516664466314916971738;
    
    uint256 constant IC6x = 14497359533645827243799861997722666718303645354348962318901049624108349510187;
    uint256 constant IC6y = 3497770920210911589966142092047483968755123344277303312088268665536795924863;
    
    uint256 constant IC7x = 14743221991794296774524862758747429853126425708903006948001377585501300187872;
    uint256 constant IC7y = 13895938908115700689899180547717599529707127245270679251166036112955589454622;
    
    uint256 constant IC8x = 18449416508275272189411544802579339523753017752816644474661495841491149662667;
    uint256 constant IC8y = 12799385565032295167761783468880453179904359627108103208822649540812831554034;
    
    uint256 constant IC9x = 8256608895797911109126621095886576394166427995848545972496401675106784571751;
    uint256 constant IC9y = 4209072155349611557464992788996852419401890200735122484807323834461190928739;
    
    uint256 constant IC10x = 13250212323296129875968369790409299580272309544376098001916698904657644128264;
    uint256 constant IC10y = 8545785330446957441014585535417671746602287025261037136761363039032012271855;
    
    uint256 constant IC11x = 8226412658089521751479481971958572479082632518024548179705174132234504163804;
    uint256 constant IC11y = 8469627372139182034772408866676132786079224021898204277883617074988483936503;
    
    uint256 constant IC12x = 14024088584708502736512200089727527964456665449405816109111816311513522336920;
    uint256 constant IC12y = 4166448112498326873927539989747996549764977131957286433221737128603399993638;
    
    uint256 constant IC13x = 3437153672859778187811595436921156907637182727413179126567134211351506826090;
    uint256 constant IC13y = 6362564336597841377385382573048782039454009506238159819123715408313193135112;
    
    uint256 constant IC14x = 4139174292882544806000695811808051484476255087445598754563368771932643958167;
    uint256 constant IC14y = 3353772724773935519506678491276646873104329382022206206381803651162636635554;
    
    uint256 constant IC15x = 5389853743530484831774724575491652129121283626071428743449358932554687997961;
    uint256 constant IC15y = 9969380410875567598129630984684486311229501472447978474267216836430146046715;
    
    uint256 constant IC16x = 13523304885419206715621713701777899495876797778863998300072627160797894473450;
    uint256 constant IC16y = 19986992122216229058772406121093105131105657527197458798978652154939625166066;
    
    uint256 constant IC17x = 18705221847323717900063459088611205112648721823128955187693327134612619709539;
    uint256 constant IC17y = 11720079191660449132265224328961503522688206608335304601588756696745163628024;
    
    uint256 constant IC18x = 127348268552297156768626830942464803794198132509293405556576238396638525710;
    uint256 constant IC18y = 5363779418455283516528184489663316272213006010066368492132876603382124072108;
    
    uint256 constant IC19x = 6744595122925051465296712277300861329871728319605055981233819573984612647;
    uint256 constant IC19y = 15550422506286403478745649869372494552380004148846230639264785708044419786653;
    
    uint256 constant IC20x = 21435778068123109927968132385139107230559569670733477922006379323991656831700;
    uint256 constant IC20y = 8469277723956824758301569150714579020679759105993322682011306626926376860072;
    
    uint256 constant IC21x = 4253680224276457040417657220531334502267925316131789758693225454783075924431;
    uint256 constant IC21y = 13450171398129731256191057910367011116728034776282257990597896012713589698281;
    
    uint256 constant IC22x = 2869165892204041651532665948341426098705741658668415139866957041174227673300;
    uint256 constant IC22y = 5306360243733039711858832569931596354177661200282361133088047211893110180416;
    
    uint256 constant IC23x = 21614143653492392582488600745695502579882338646722530327547728885958352806229;
    uint256 constant IC23y = 5471202803682563990545807776554354471624410643238001186343481771573843561919;
    
    uint256 constant IC24x = 6100986630280886795441232247811237877665263546810434062086979729233064971197;
    uint256 constant IC24y = 16451320891216913392879132268457585990908090229807943763165608273409052024634;
    
    uint256 constant IC25x = 19839613377896117550363423872306758991093135087348575473004237041231476110576;
    uint256 constant IC25y = 5647685412160549894252366322708804356491359912446361778543408618290807576941;
    
    uint256 constant IC26x = 1067879914011257684879133706931666812912614208460508203974215265990428557005;
    uint256 constant IC26y = 12977793775688208319001831690733339421459600708951694876082522648452059718316;
    
    uint256 constant IC27x = 6150000782386799495695521251866609739910923607076284321887314038770369702065;
    uint256 constant IC27y = 11920274610990579552533786063389603078867520031766618983839695472823134643500;
    
    uint256 constant IC28x = 5264590244730556948436080377229786256316455276746372232083213103205784341301;
    uint256 constant IC28y = 14856167452139226351919951238322878699909136601716622077309500813242534762406;
    
    uint256 constant IC29x = 11787636185895968433427373856686167701823470828097944261327803639510207210873;
    uint256 constant IC29y = 368186262055506098604828361238249882827645873959593460704229607180727001242;
    
    uint256 constant IC30x = 16841930526342912028717237655254220756510691819935005283711667326944945859204;
    uint256 constant IC30y = 1062674457049099457304124471200641650732240392259675272140040937803501658739;
    
    uint256 constant IC31x = 4266716437252043227404243058232196660237998675222384261391601079550403863760;
    uint256 constant IC31y = 20868360267333304665777149746960852590843789976794956994487432998439568108384;
    
    uint256 constant IC32x = 5444601666933659105801786614896255282878887995492502330637463696444713754062;
    uint256 constant IC32y = 11116197049373428014515830960610290343877734584678887005453742372132294916978;
    
    uint256 constant IC33x = 14725675865669135164896426763734989306798968022385467217192405424172374373339;
    uint256 constant IC33y = 13476554142871362474101870686405173620470839269652738299914728101526649759003;
    
    uint256 constant IC34x = 11591228302896683457021986334119802542881708460247734095876422421979949695248;
    uint256 constant IC34y = 14596599531009227164228628243472699779569092263744253934151085048130181084161;
    
    uint256 constant IC35x = 16102646343554524078235761456784169054459189776143968797719441064460259995715;
    uint256 constant IC35y = 11986955567909046459898779152509668063745749338610589747500416766855025401073;
    
    uint256 constant IC36x = 6585085087053745394178418539768310080999167559991029451984523762425995609205;
    uint256 constant IC36y = 15438624538039050079282272978385273451488385476918453644850013245082318763231;
    
    uint256 constant IC37x = 12805977840770941058160616003278835169550048974890087488756266416729884676947;
    uint256 constant IC37y = 19174336974108133807793237558491128456355778917141211519412477527894110213888;
    
    uint256 constant IC38x = 3045004841884057005806198201912278728719172100255943091127108728806947590928;
    uint256 constant IC38y = 558134292452795365224732244557433318093025030049238875232931359072367548527;
    
    uint256 constant IC39x = 5027603899013346184436075485205473840770498856443485813754807912865529033036;
    uint256 constant IC39y = 18833431065607888978048066580720180006006644197082720908005701266053250686998;
    
    uint256 constant IC40x = 18694880836851609847367403730769251789899357221095276057903957091742865280336;
    uint256 constant IC40y = 3977365828516772672832547627343062009106218571484433451244473116865879766226;
    
    uint256 constant IC41x = 5422313583272876495687646708446169647855090697154299062586367445174275058651;
    uint256 constant IC41y = 10983350655966342950517133954734105833869177180121572384139904483174873142475;
    
    uint256 constant IC42x = 16125201690582910652495076989980319399143938713100052258526450717937625375330;
    uint256 constant IC42y = 18142187302596071888973149986082160455663852977495636581983453566275523319874;
    
    uint256 constant IC43x = 13274307255695819216972672092922895156809732911786849818723347794088189841306;
    uint256 constant IC43y = 18044385239066599285791827910045369595751564569090815687617630842010938835463;
    
    uint256 constant IC44x = 11063025737138867868222316584361201666101816317609401274001086666861236772701;
    uint256 constant IC44y = 5958642738655359251168470612033623093865865849686537097674613119529836039799;
    
    uint256 constant IC45x = 2010541984199582147123272695962731493209996219347485322928352163658028851115;
    uint256 constant IC45y = 11930539795975354940734650292078083691122317331751147808251236670665395335650;
    
    uint256 constant IC46x = 20265715565169528896902264365555154155972422379690606092549545180342550011067;
    uint256 constant IC46y = 11081791043368572593214379220938768722825444765791181132923426928111248261503;
    
    uint256 constant IC47x = 18392687802294747976439403380062120208452710693973733441657554225961030908175;
    uint256 constant IC47y = 13934951453251171918364743108259366926314840550314929525148415405125005450904;
    
    uint256 constant IC48x = 11194917149395134708615284963011981865006876195876212215681533976042837873872;
    uint256 constant IC48y = 20936386904227176331612978937860403697232765450854049974761844100488252694669;
    
    uint256 constant IC49x = 936584039135901285369435213613017652612982061338224400336694547549400562968;
    uint256 constant IC49y = 15121490625129173958565821055161198947064015199002405512977193848208004353999;
    
    uint256 constant IC50x = 3910623527995041722715944187632819663081585093511525500924988776412182635505;
    uint256 constant IC50y = 20019984002816509959587264992804500680128209302272861026813179171727303727550;
    
    uint256 constant IC51x = 323404395762220680857542105091006038521716065911116260849046607245784497718;
    uint256 constant IC51y = 20320673879752133142363558971780225001640996869621547300886314671452696765234;
    
    uint256 constant IC52x = 30295548279471865737109888724992108673611802076100324585738449769680285706;
    uint256 constant IC52y = 11402623476555051633242277518592377695044817243481258956668278176047121406136;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[52] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                
                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))
                
                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))
                
                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))
                
                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))
                
                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))
                
                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))
                
                g1_mulAccC(_pVk, IC26x, IC26y, calldataload(add(pubSignals, 800)))
                
                g1_mulAccC(_pVk, IC27x, IC27y, calldataload(add(pubSignals, 832)))
                
                g1_mulAccC(_pVk, IC28x, IC28y, calldataload(add(pubSignals, 864)))
                
                g1_mulAccC(_pVk, IC29x, IC29y, calldataload(add(pubSignals, 896)))
                
                g1_mulAccC(_pVk, IC30x, IC30y, calldataload(add(pubSignals, 928)))
                
                g1_mulAccC(_pVk, IC31x, IC31y, calldataload(add(pubSignals, 960)))
                
                g1_mulAccC(_pVk, IC32x, IC32y, calldataload(add(pubSignals, 992)))
                
                g1_mulAccC(_pVk, IC33x, IC33y, calldataload(add(pubSignals, 1024)))
                
                g1_mulAccC(_pVk, IC34x, IC34y, calldataload(add(pubSignals, 1056)))
                
                g1_mulAccC(_pVk, IC35x, IC35y, calldataload(add(pubSignals, 1088)))
                
                g1_mulAccC(_pVk, IC36x, IC36y, calldataload(add(pubSignals, 1120)))
                
                g1_mulAccC(_pVk, IC37x, IC37y, calldataload(add(pubSignals, 1152)))
                
                g1_mulAccC(_pVk, IC38x, IC38y, calldataload(add(pubSignals, 1184)))
                
                g1_mulAccC(_pVk, IC39x, IC39y, calldataload(add(pubSignals, 1216)))
                
                g1_mulAccC(_pVk, IC40x, IC40y, calldataload(add(pubSignals, 1248)))
                
                g1_mulAccC(_pVk, IC41x, IC41y, calldataload(add(pubSignals, 1280)))
                
                g1_mulAccC(_pVk, IC42x, IC42y, calldataload(add(pubSignals, 1312)))
                
                g1_mulAccC(_pVk, IC43x, IC43y, calldataload(add(pubSignals, 1344)))
                
                g1_mulAccC(_pVk, IC44x, IC44y, calldataload(add(pubSignals, 1376)))
                
                g1_mulAccC(_pVk, IC45x, IC45y, calldataload(add(pubSignals, 1408)))
                
                g1_mulAccC(_pVk, IC46x, IC46y, calldataload(add(pubSignals, 1440)))
                
                g1_mulAccC(_pVk, IC47x, IC47y, calldataload(add(pubSignals, 1472)))
                
                g1_mulAccC(_pVk, IC48x, IC48y, calldataload(add(pubSignals, 1504)))
                
                g1_mulAccC(_pVk, IC49x, IC49y, calldataload(add(pubSignals, 1536)))
                
                g1_mulAccC(_pVk, IC50x, IC50y, calldataload(add(pubSignals, 1568)))
                
                g1_mulAccC(_pVk, IC51x, IC51y, calldataload(add(pubSignals, 1600)))
                
                g1_mulAccC(_pVk, IC52x, IC52y, calldataload(add(pubSignals, 1632)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            
            checkField(calldataload(add(_pubSignals, 608)))
            
            checkField(calldataload(add(_pubSignals, 640)))
            
            checkField(calldataload(add(_pubSignals, 672)))
            
            checkField(calldataload(add(_pubSignals, 704)))
            
            checkField(calldataload(add(_pubSignals, 736)))
            
            checkField(calldataload(add(_pubSignals, 768)))
            
            checkField(calldataload(add(_pubSignals, 800)))
            
            checkField(calldataload(add(_pubSignals, 832)))
            
            checkField(calldataload(add(_pubSignals, 864)))
            
            checkField(calldataload(add(_pubSignals, 896)))
            
            checkField(calldataload(add(_pubSignals, 928)))
            
            checkField(calldataload(add(_pubSignals, 960)))
            
            checkField(calldataload(add(_pubSignals, 992)))
            
            checkField(calldataload(add(_pubSignals, 1024)))
            
            checkField(calldataload(add(_pubSignals, 1056)))
            
            checkField(calldataload(add(_pubSignals, 1088)))
            
            checkField(calldataload(add(_pubSignals, 1120)))
            
            checkField(calldataload(add(_pubSignals, 1152)))
            
            checkField(calldataload(add(_pubSignals, 1184)))
            
            checkField(calldataload(add(_pubSignals, 1216)))
            
            checkField(calldataload(add(_pubSignals, 1248)))
            
            checkField(calldataload(add(_pubSignals, 1280)))
            
            checkField(calldataload(add(_pubSignals, 1312)))
            
            checkField(calldataload(add(_pubSignals, 1344)))
            
            checkField(calldataload(add(_pubSignals, 1376)))
            
            checkField(calldataload(add(_pubSignals, 1408)))
            
            checkField(calldataload(add(_pubSignals, 1440)))
            
            checkField(calldataload(add(_pubSignals, 1472)))
            
            checkField(calldataload(add(_pubSignals, 1504)))
            
            checkField(calldataload(add(_pubSignals, 1536)))
            
            checkField(calldataload(add(_pubSignals, 1568)))
            
            checkField(calldataload(add(_pubSignals, 1600)))
            
            checkField(calldataload(add(_pubSignals, 1632)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
