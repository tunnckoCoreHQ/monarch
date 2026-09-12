// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {ERC721} from "solady/tokens/ERC721.sol";
import {ERC1155} from "solady/tokens/ERC1155.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {MewsForwarder} from "../src/MewsForwarder.sol";
import {ILaunchFactory} from "../src/openlaunch/OpenLaunchInterfaces.sol";

contract Coin is ERC20 {
    function name() public pure override returns (string memory) {
        return "Coin";
    }

    function symbol() public pure override returns (string memory) {
        return "COIN";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// Burns 1% of every transfer, like a fee-on-transfer token.
contract TaxedCoin is Coin {
    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 tax = amount / 100;
        _burn(msg.sender, tax);
        return super.transfer(to, amount - tax);
    }
}

contract Collectible is ERC721 {
    function name() public pure override returns (string memory) {
        return "Collectible";
    }

    function symbol() public pure override returns (string memory) {
        return "NFT";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract Multi is ERC1155 {
    function uri(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

// Factory and locker in one. Pays out like the real locker: ETH pushed with a 50,000 gas
// cap and credited on failure, ERC20s transferred.
contract LaunchDouble {
    mapping(address => uint256) public tokenIdOf;
    mapping(address => mapping(address => uint256)) public claimable;
    address private _recipient;
    Coin private _token;
    address private _quote;

    function locker() external view returns (address) {
        return address(this);
    }

    function register(Coin token, uint256 tokenId, address quote, address recipient) external {
        tokenIdOf[address(token)] = tokenId;
        _token = token;
        _quote = quote;
        _recipient = recipient;
    }

    function infoOf(address token)
        external
        view
        returns (uint256 tokenId, address, address quote, int24, uint24)
    {
        return (tokenIdOf[token], address(0), _quote, 0, 0);
    }

    function fund(uint256 tokens) external payable {
        _token.mint(address(this), tokens);
    }

    function collect(uint256) external returns (uint256 quoteOut, uint256 tokenOut) {
        if (_quote == address(0)) {
            quoteOut = address(this).balance;
            (bool paid,) = _recipient.call{value: quoteOut, gas: 50_000}("");
            if (!paid) {
                claimable[_recipient][address(0)] += quoteOut;
            }
        } else {
            quoteOut = Coin(_quote).balanceOf(address(this));
            SafeTransferLib.safeTransfer(_quote, _recipient, quoteOut);
        }
        tokenOut = _token.balanceOf(address(this));
        SafeTransferLib.safeTransfer(address(_token), _recipient, tokenOut);
    }
}

// Calls flush again from inside the reward transfer.
contract Reenterer {
    MewsForwarder private _forwarder;
    uint256 public rewards;

    function run(MewsForwarder forwarder) external {
        _forwarder = forwarder;
        forwarder.flush();
    }

    receive() external payable {
        if (rewards++ < 3) {
            _forwarder.flush();
        }
    }
}

contract MewsForwarderTest is Test {
    event Flushed(address indexed caller, uint256 burned);
    event Forwarded(
        address indexed caller, address indexed currency, uint256 forwarded, uint256 reward
    );

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant ACCOUNT = address(0xACC);
    address internal constant AUTOMATION = address(0xA07);
    address internal constant KEEPER = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    LaunchDouble internal launch;
    Collectible internal mews;
    Coin internal token;
    MewsForwarder internal forwarder;

    function setUp() public {
        launch = new LaunchDouble();
        mews = new Collectible();
        token = new Coin();
        forwarder = new MewsForwarder(
            ILaunchFactory(address(launch)), address(token), address(mews), ACCOUNT, AUTOMATION
        );
        token.mint(KEEPER, 100_000 ether);
    }

    function _launch(address quote) internal {
        launch.register(token, 7, quote, address(forwarder));
    }

    function testConstructorBindsAccountAsOwner() public view {
        assertEq(address(forwarder.factory()), address(launch));
        assertEq(address(forwarder.locker()), address(launch));
        assertEq(forwarder.token(), address(token));
        assertEq(forwarder.nft(), address(mews));
        assertEq(forwarder.account(), ACCOUNT);
        assertEq(forwarder.automation(), AUTOMATION);
        assertEq(forwarder.owner(), ACCOUNT);
        assertEq(forwarder.rewardBps(), 100);
        assertEq(forwarder.minTokens(), 100_000 ether);
        assertEq(forwarder.minNfts(), 3);
    }

    function testFlushCollectsBurnsAndForwardsNativeQuote() public {
        _launch(address(0));
        launch.fund{value: 1 ether}(1000 ether);

        vm.expectEmit(address(forwarder));
        emit Flushed(KEEPER, 1000 ether);
        vm.expectEmit(address(forwarder));
        emit Forwarded(KEEPER, address(0), 0.99 ether, 0.01 ether);
        vm.prank(KEEPER);
        forwarder.flush();

        assertEq(token.balanceOf(DEAD), 1000 ether);
        assertEq(token.balanceOf(address(forwarder)), 0);
        assertEq(AUTOMATION.balance, 0.99 ether);
        assertEq(KEEPER.balance, 0.01 ether);
        assertEq(address(forwarder).balance, 0);
        assertEq(launch.claimable(address(forwarder), address(0)), 0);
    }

    function testFlushForwardsErc20QuoteAndEth() public {
        Coin quote = new Coin();
        _launch(address(quote));
        quote.mint(address(launch), 200 ether);
        launch.fund(1000 ether);
        vm.deal(address(forwarder), 1 ether);

        vm.prank(KEEPER);
        forwarder.flush();

        assertEq(token.balanceOf(DEAD), 1000 ether);
        assertEq(quote.balanceOf(AUTOMATION), 198 ether);
        assertEq(quote.balanceOf(KEEPER), 2 ether);
        assertEq(quote.balanceOf(address(forwarder)), 0);
        assertEq(AUTOMATION.balance, 0.99 ether);
        assertEq(KEEPER.balance, 0.01 ether);
    }

    function testFlushForwardsEthBeforeLaunch() public {
        vm.deal(address(forwarder), 2 ether);
        vm.prank(KEEPER);
        forwarder.flush();

        assertEq(AUTOMATION.balance, 1.98 ether);
        assertEq(KEEPER.balance, 0.02 ether);
    }

    function testFlushPaysOneRewardToReenteringCaller() public {
        _launch(address(0));
        launch.fund{value: 1 ether}(0);
        Reenterer reenterer = new Reenterer();
        token.mint(address(reenterer), 100_000 ether);

        reenterer.run(forwarder);

        assertEq(reenterer.rewards(), 1);
        assertEq(address(reenterer).balance, 0.01 ether);
        assertEq(AUTOMATION.balance, 0.99 ether);
    }

    function testFlushWithNothingIsANoOp() public {
        _launch(address(0));
        vm.prank(KEEPER);
        forwarder.flush();

        assertEq(AUTOMATION.balance, 0);
        assertEq(KEEPER.balance, 0);
        assertEq(token.balanceOf(DEAD), 0);
    }

    function testForwardSplitsOtherTokens() public {
        Coin other = new Coin();
        other.mint(address(forwarder), 500 ether);

        vm.expectEmit(address(forwarder));
        emit Forwarded(KEEPER, address(other), 495 ether, 5 ether);
        vm.prank(KEEPER);
        forwarder.forward(address(other));

        assertEq(other.balanceOf(AUTOMATION), 495 ether);
        assertEq(other.balanceOf(KEEPER), 5 ether);
    }

    function testForwardHandlesFeeOnTransferTokens() public {
        TaxedCoin taxed = new TaxedCoin();
        taxed.mint(address(forwarder), 1000 ether);

        vm.prank(KEEPER);
        forwarder.forward(address(taxed));

        assertEq(taxed.balanceOf(KEEPER), 9.9 ether);
        assertEq(taxed.balanceOf(AUTOMATION), 980.1 ether);
        assertEq(taxed.balanceOf(address(forwarder)), 0);
    }

    function testForwardRejectsLaunchToken() public {
        token.mint(address(forwarder), 1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(MewsForwarder.BurnedToken.selector);
        forwarder.forward(address(token));
    }

    function testForwardNFTRescuesPlainTransfers() public {
        Collectible nft = new Collectible();
        nft.mint(address(forwarder), 1);

        forwarder.forwardNFT(address(nft), 1);
        assertEq(nft.ownerOf(1), ACCOUNT);
    }

    function testSafeTransferredErc721LandsInAccount() public {
        Collectible nft = new Collectible();
        nft.mint(ALICE, 1);

        vm.prank(ALICE);
        nft.safeTransferFrom(ALICE, address(forwarder), 1);
        assertEq(nft.ownerOf(1), ACCOUNT);
    }

    function testErc1155TransfersLandInAccount() public {
        Multi multi = new Multi();
        multi.mint(ALICE, 1, 10);
        multi.mint(ALICE, 2, 20);

        vm.prank(ALICE);
        multi.safeTransferFrom(ALICE, address(forwarder), 1, 4, "");
        assertEq(multi.balanceOf(ACCOUNT, 1), 4);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 6;
        amounts[1] = 20;
        vm.prank(ALICE);
        multi.safeBatchTransferFrom(ALICE, address(forwarder), ids, amounts, "");
        assertEq(multi.balanceOf(ACCOUNT, 1), 10);
        assertEq(multi.balanceOf(ACCOUNT, 2), 20);
        assertEq(multi.balanceOf(address(forwarder), 1), 0);
    }

    function testOnlyHoldersFlushAndForward() public {
        vm.deal(address(forwarder), 1 ether);
        Coin other = new Coin();
        other.mint(address(forwarder), 1 ether);
        token.mint(ALICE, 99_999 ether);
        mews.mint(ALICE, 1);
        mews.mint(ALICE, 2);

        vm.startPrank(ALICE);
        vm.expectRevert(MewsForwarder.NotHolder.selector);
        forwarder.flush();
        vm.expectRevert(MewsForwarder.NotHolder.selector);
        forwarder.forward(address(other));
        vm.stopPrank();

        mews.mint(ALICE, 3);
        vm.startPrank(ALICE);
        forwarder.flush();
        forwarder.forward(address(other));
        vm.stopPrank();
        assertEq(ALICE.balance, 0.01 ether);
        assertEq(other.balanceOf(ALICE), 0.01 ether);
    }

    function testSetMinTokensAndMinNftsAreOwnerOnly() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        forwarder.setMinTokens(1);
        vm.expectRevert(Ownable.Unauthorized.selector);
        forwarder.setMinNfts(1);

        vm.startPrank(ACCOUNT);
        forwarder.setMinTokens(500_000 ether);
        forwarder.setMinNfts(1);
        vm.stopPrank();
        assertEq(forwarder.minTokens(), 500_000 ether);
        assertEq(forwarder.minNfts(), 1);

        vm.deal(address(forwarder), 1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(MewsForwarder.NotHolder.selector);
        forwarder.flush();
        mews.mint(KEEPER, 1);
        vm.prank(KEEPER);
        forwarder.flush();
        assertEq(KEEPER.balance, 0.01 ether);
    }

    function testSetRewardIsBoundedAndOwnerOnly() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        forwarder.setReward(200);

        vm.startPrank(ACCOUNT);
        vm.expectRevert(MewsForwarder.InvalidReward.selector);
        forwarder.setReward(99);
        vm.expectRevert(MewsForwarder.InvalidReward.selector);
        forwarder.setReward(5001);
        forwarder.setReward(5000);
        vm.stopPrank();
        assertEq(forwarder.rewardBps(), 5000);

        vm.deal(address(forwarder), 1 ether);
        vm.prank(KEEPER);
        forwarder.flush();
        assertEq(AUTOMATION.balance, 0.5 ether);
        assertEq(KEEPER.balance, 0.5 ether);
    }
}
